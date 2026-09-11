import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { openPersistentD1 } from '../lib/node-d1.ts';
import {
  inspectNotifications,
  reconcileNotification,
  type NotificationEvidence,
} from '../lib/notification-operations.ts';

type Value = string | number | null;

function sqlValue(value: Value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Unsafe SQL number.');
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function boundSql(sql: string, values: Value[]) {
  let index = 0;
  const result = sql.replaceAll('?', () => {
    if (index >= values.length) throw new Error('Missing SQL binding.');
    return sqlValue(values[index++]);
  });
  if (index !== values.length) throw new Error('Unused SQL binding.');
  return result;
}

function wranglerResult(output: string) {
  const value = JSON.parse(output) as unknown;
  if (!Array.isArray(value) || !value[0] || typeof value[0] !== 'object')
    throw new Error('Wrangler returned an unexpected result.');
  return value[0] as { results?: Record<string, unknown>[]; success?: boolean };
}

class WranglerStatement {
  constructor(
    private sql: string,
    private args: string[],
    private values: Value[] = [],
  ) {}

  bind(...values: Value[]) {
    return new WranglerStatement(this.sql, this.args, values);
  }

  private execute() {
    const result = spawnSync(
      'npx',
      [
        'wrangler',
        'd1',
        'execute',
        ...this.args,
        '--command',
        boundSql(this.sql, this.values),
        '--json',
        '--yes',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(result.stderr.trim() || 'Wrangler D1 command failed.');
    return wranglerResult(result.stdout);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.execute().results?.[0];
    if (!row) return null;
    if (column !== undefined) return (row[column] as T) ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>() {
    const result = this.execute();
    return {
      success: result.success ?? true,
      results: result.results ?? [],
    } as D1Result<T>;
  }

  async run<T = Record<string, unknown>>() {
    const result = this.execute();
    return {
      success: result.success ?? true,
      results: result.results ?? [],
    } as D1Result<T>;
  }
}

function wranglerDatabase(args: string[]) {
  return {
    prepare(sql: string) {
      return new WranglerStatement(sql, args);
    },
  } as unknown as D1Database;
}

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  if (command !== 'inspect' && command !== 'reconcile')
    throw new Error('Use inspect or reconcile.');
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--'))
      throw new Error(`Invalid option near ${key ?? 'end of command'}.`);
    if (options.has(key)) throw new Error(`Repeated option ${key}.`);
    options.set(key, value);
  }
  return { command, options };
}

function option(options: Map<string, string>, name: string, required = false) {
  const value = options.get(`--${name}`);
  if (required && !value) throw new Error(`--${name} is required.`);
  return value;
}

function databaseFrom(options: Map<string, string>) {
  const runtime = option(options, 'runtime', true);
  if (runtime === 'node') {
    const databasePath = resolve(option(options, 'db', true)!);
    const opened = openPersistentD1(databasePath);
    return { db: opened.db, close: () => opened.sqlite.close() };
  }
  if (runtime !== 'd1') throw new Error('--runtime must be node or d1.');
  const database = option(options, 'database', true)!;
  const config = resolve(option(options, 'config', true)!);
  const target = option(options, 'target', true);
  const args = [database, '--config', config];
  if (target === 'local') {
    args.push(
      '--local',
      '--persist-to',
      resolve(option(options, 'persist-to', true)!),
    );
  } else if (target === 'remote') {
    if (option(options, 'confirm-remote', true) !== database)
      throw new Error('--confirm-remote must exactly match --database.');
    args.push('--remote');
    const environment = option(options, 'env');
    if (environment) args.push('--env', environment);
  } else {
    throw new Error('--target must be local or remote.');
  }
  return { db: wranglerDatabase(args), close: () => undefined };
}

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  const allowed = new Set(
    command === 'inspect'
      ? [
          '--runtime',
          '--db',
          '--database',
          '--config',
          '--target',
          '--persist-to',
          '--confirm-remote',
          '--env',
          '--delivery',
          '--status',
          '--cursor',
          '--limit',
        ]
      : [
          '--runtime',
          '--db',
          '--database',
          '--config',
          '--target',
          '--persist-to',
          '--confirm-remote',
          '--env',
          '--delivery',
          '--action-id',
          '--operator',
          '--evidence',
          '--provider-id',
          '--note',
        ],
  );
  for (const key of options.keys())
    if (!allowed.has(key)) throw new Error(`Unknown option ${key}.`);

  const connection = databaseFrom(options);
  try {
    if (command === 'inspect') {
      const limit = option(options, 'limit');
      const inspection = await inspectNotifications(connection.db, {
        ...(option(options, 'delivery')
          ? { deliveryId: option(options, 'delivery') }
          : {}),
        ...(option(options, 'status')
          ? { status: option(options, 'status') as 'blocked' }
          : {}),
        ...(option(options, 'cursor')
          ? { cursor: option(options, 'cursor') }
          : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      });
      console.log(JSON.stringify(inspection, null, 2));
      return;
    }
    const evidence = option(options, 'evidence', true) as NotificationEvidence;
    const reconciliation = await reconcileNotification(connection.db, {
      actionId: option(options, 'action-id', true)!,
      deliveryId: option(options, 'delivery', true)!,
      operatorId: option(options, 'operator', true)!,
      evidence,
      note: option(options, 'note', true)!,
      ...(option(options, 'provider-id')
        ? { providerId: option(options, 'provider-id') }
        : {}),
    });
    console.log(JSON.stringify({ reconciliation }, null, 2));
  } finally {
    connection.close();
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Notification operation failed.',
  );
  process.exitCode = 1;
});
