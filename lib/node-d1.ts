import {
  chmodSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite';
import { verifyNodeDatabase } from './node-migrations.ts';

type BoundValue = string | number | null | ArrayBuffer;

function sqliteValue(value: BoundValue) {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function meta(changes?: StatementResultingChanges) {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: Number(changes?.changes ?? 0),
    last_row_id: Number(changes?.lastInsertRowid ?? 0),
    changed_db: Number(changes?.changes ?? 0) > 0,
    changes: Number(changes?.changes ?? 0),
  };
}

class NodePreparedStatement {
  constructor(
    private sqlite: DatabaseSync,
    private sql: string,
    private values: BoundValue[] = [],
  ) {}

  bind(...values: BoundValue[]) {
    return new NodePreparedStatement(this.sqlite, this.sql, values);
  }

  private parameters() {
    return this.values.map(sqliteValue);
  }

  executeAll() {
    const results = this.sqlite.prepare(this.sql).all(...this.parameters());
    return { success: true, meta: meta(), results };
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.sqlite.prepare(this.sql).get(...this.parameters());
    if (!row) return null;
    if (column !== undefined) {
      if (!(column in row))
        throw new Error(`Column "${column}" was not present in the result.`);
      return row[column] as T;
    }
    return row as T;
  }

  async all<T = Record<string, unknown>>() {
    return this.executeAll() as unknown as D1Result<T>;
  }

  async run<T = Record<string, unknown>>() {
    const changes = this.sqlite.prepare(this.sql).run(...this.parameters());
    return {
      success: true,
      meta: meta(changes),
      results: [] as T[],
    } as unknown as D1Result<T>;
  }

  async raw<T = unknown[]>() {
    const statement = this.sqlite.prepare(this.sql);
    statement.setReturnArrays(true);
    return statement.all(...this.parameters()) as T[];
  }
}

export function createNodeD1(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new NodePreparedStatement(sqlite, sql);
    },
    async batch(statements: NodePreparedStatement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => {
          if (!(statement instanceof NodePreparedStatement))
            throw new TypeError('Batch statements must belong to the Node D1 adapter.');
          return statement.executeAll();
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

export function openNodeSqlite(
  databasePath: string,
  options: { create?: boolean; readOnly?: boolean } = {},
) {
  if (!databasePath || databasePath === ':memory:')
    throw new Error('MD_COLAB_DB_PATH must be a persistent filesystem path.');
  const resolvedPath = resolve(databasePath);
  const existed = existsSync(resolvedPath);
  if (!existed && !options.create)
    throw new Error(
      `Database does not exist at ${resolvedPath}; run db:node migrate first.`,
    );
  if (!existed)
    mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const sqlite = new DatabaseSync(resolvedPath, {
    enableForeignKeyConstraints: true,
    readOnly: options.readOnly,
    timeout: 5000,
  });
  try {
    sqlite.exec('PRAGMA busy_timeout=5000');
    if (!options.readOnly) {
      sqlite.exec('PRAGMA journal_mode=WAL');
      sqlite.exec('PRAGMA synchronous=FULL');
    }
    if (!existed) chmodSync(resolvedPath, 0o600);
    return { sqlite, path: resolvedPath };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export function openPersistentD1(
  databasePath: string,
  migrationsPath?: string,
) {
  const opened = openNodeSqlite(databasePath);
  try {
    verifyNodeDatabase(opened.sqlite, migrationsPath);
    return {
      ...opened,
      db: createNodeD1(opened.sqlite),
    };
  } catch (error) {
    opened.sqlite.close();
    throw error;
  }
}
