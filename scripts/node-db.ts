import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openNodeSqlite } from '../lib/node-d1.ts';
import {
  inspectNodeMigrations,
  migrationDirectory,
} from '../lib/node-migrations.ts';
import {
  backupNodeDatabase,
  migrateNodePath,
  restoreNodeDatabase,
} from '../lib/node-operations.ts';

const [command, ...tokens] = process.argv.slice(2);
const allowedCommands = new Set(['status', 'migrate', 'backup', 'restore']);

function argumentsFrom(values: string[]) {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--'))
      throw new Error('Every option must be a --name value pair.');
    if (result.has(key)) throw new Error(`Duplicate option: ${key}.`);
    result.set(key, value);
  }
  return result;
}

function only(values: Map<string, string>, names: string[]) {
  for (const key of values.keys())
    if (!names.includes(key)) throw new Error(`Unknown option: ${key}.`);
}

function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value) throw new Error(`Missing required option ${key}.`);
  return value;
}

async function main() {
  if (!command || !allowedCommands.has(command))
    throw new Error('Usage: db:node <status|migrate|backup|restore> [options].');
  const values = argumentsFrom(tokens);
  const migrationsPath = values.get('--migrations') ?? migrationDirectory();

  if (command === 'status') {
    only(values, ['--database', '--migrations']);
    const database = resolve(required(values, '--database'));
    if (!existsSync(database)) {
      console.log(JSON.stringify({ database, exists: false }, null, 2));
      return;
    }
    const opened = openNodeSqlite(database, { readOnly: true });
    try {
      console.log(
        JSON.stringify(
          {
            database,
            exists: true,
            ...inspectNodeMigrations(opened.sqlite, migrationsPath),
          },
          null,
          2,
        ),
      );
    } finally {
      opened.sqlite.close();
    }
    return;
  }

  if (command === 'migrate') {
    only(values, ['--database', '--backup-output', '--migrations']);
    const database = required(values, '--database');
    if (existsSync(resolve(database))) {
      const opened = openNodeSqlite(database, { readOnly: true });
      let status;
      try {
        status = inspectNodeMigrations(opened.sqlite, migrationsPath);
      } finally {
        opened.sqlite.close();
      }
      if (status.tracked && status.applied.length > 0 && status.pending.length > 0) {
        const output = values.get('--backup-output');
        if (!output)
          throw new Error(
            'A tracked database with pending migrations requires --backup-output.',
          );
        await backupNodeDatabase(database, output, {
          allowPending: true,
          migrationsPath,
        });
      }
    }
    const result = migrateNodePath(database, migrationsPath);
    console.log(
      JSON.stringify(
        {
          database: result.path,
          applied: result.after.applied,
          pending: result.after.pending,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'backup') {
    only(values, ['--database', '--output', '--migrations']);
    const result = await backupNodeDatabase(
      required(values, '--database'),
      required(values, '--output'),
      { migrationsPath },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  only(values, ['--backup', '--output', '--migrations']);
  const result = await restoreNodeDatabase(
    required(values, '--backup'),
    required(values, '--output'),
    { migrationsPath },
  );
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Unknown database error.');
  process.exitCode = 1;
});
