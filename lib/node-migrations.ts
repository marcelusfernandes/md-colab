import { createHash } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  type PathLike,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const LEDGER = '_md_colab_migrations';

export type NodeMigration = {
  name: string;
  checksum: string;
  sql: string;
};

type LedgerRow = {
  sequence: number;
  name: string;
  checksum: string;
};

function checksum(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function migrationDirectory() {
  return resolve(process.env.MD_COLAB_MIGRATIONS_DIR ?? 'drizzle');
}

export function loadNodeMigrations(
  directory: PathLike = migrationDirectory(),
): NodeMigration[] {
  const path = String(directory);
  const journal = JSON.parse(
    readFileSync(join(path, 'meta', '_journal.json'), 'utf8'),
  ) as { entries?: { tag?: unknown }[] };
  const journalNames = (journal.entries ?? []).map((entry) => entry.tag);
  if (
    journalNames.some((name) => typeof name !== 'string') ||
    new Set(journalNames).size !== journalNames.length
  )
    throw new Error('The Drizzle migration journal is invalid.');

  const files = readdirSync(path)
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  const names = files.map((file) => basename(file, '.sql'));
  if (
    names.length === 0 ||
    names.length !== journalNames.length ||
    names.some((name, index) => name !== journalNames[index])
  )
    throw new Error(
      'The migration SQL files do not exactly match drizzle/meta/_journal.json.',
    );

  return files.map((file) => {
    const sql = readFileSync(join(path, file), 'utf8');
    return { name: basename(file, '.sql'), checksum: checksum(sql), sql };
  });
}

function userObjects(sqlite: DatabaseSync) {
  return sqlite
    .prepare(
      `SELECT type,name FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
    )
    .all() as { type: string; name: string }[];
}

function ledgerExists(sqlite: DatabaseSync) {
  return Boolean(
    sqlite
      .prepare(
        `SELECT 1 FROM sqlite_schema
         WHERE type='table' AND name=?`,
      )
      .get(LEDGER),
  );
}

function ledgerRows(sqlite: DatabaseSync): LedgerRow[] {
  return sqlite
    .prepare(
      `SELECT sequence,name,checksum FROM "${LEDGER}" ORDER BY sequence`,
    )
    .all() as LedgerRow[];
}

function validateLedger(rows: LedgerRow[], migrations: NodeMigration[]) {
  if (rows.length > migrations.length)
    throw new Error('Migration ledger contains unknown entries.');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = migrations[index];
    if (
      row.sequence !== index + 1 ||
      row.name !== expected.name ||
      row.checksum !== expected.checksum
    )
      throw new Error(
        `Migration ledger diverges at sequence ${index + 1}; refusing to continue.`,
      );
  }
}

function foreignKeyViolations(sqlite: DatabaseSync) {
  return sqlite.prepare('PRAGMA foreign_key_check').all();
}

export function inspectNodeMigrations(
  sqlite: DatabaseSync,
  directory: PathLike = migrationDirectory(),
) {
  const migrations = loadNodeMigrations(directory);
  const objects = userObjects(sqlite);
  if (!ledgerExists(sqlite)) {
    return {
      tracked: false,
      legacy: objects.length > 0,
      objects,
      applied: [] as string[],
      pending: migrations.map((migration) => migration.name),
    };
  }
  const rows = ledgerRows(sqlite);
  validateLedger(rows, migrations);
  return {
    tracked: true,
    legacy: false,
    objects,
    applied: rows.map((row) => row.name),
    pending: migrations.slice(rows.length).map((migration) => migration.name),
  };
}

function transaction(sqlite: DatabaseSync, operation: () => void) {
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    operation();
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

export function migrateNodeDatabase(
  sqlite: DatabaseSync,
  directory: PathLike = migrationDirectory(),
  through = Number.POSITIVE_INFINITY,
) {
  const migrations = loadNodeMigrations(directory);
  const target = Math.min(through, migrations.length);
  if (!Number.isInteger(target) || target < 0)
    throw new Error('Invalid migration target.');
  const objects = userObjects(sqlite);
  if (!ledgerExists(sqlite)) {
    if (objects.length > 0)
      throw new Error(
        'Database contains objects without the md-colab migration ledger; refusing to adopt unknown legacy state.',
      );
    transaction(sqlite, () => {
      sqlite.exec(
        `CREATE TABLE "${LEDGER}" (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
          name TEXT NOT NULL UNIQUE,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )`,
      );
    });
  }

  const rows = ledgerRows(sqlite);
  validateLedger(rows, migrations);
  for (const migration of migrations.slice(rows.length, target)) {
    transaction(sqlite, () => {
      sqlite.exec(migration.sql);
      sqlite
        .prepare(
          `INSERT INTO "${LEDGER}" (name,checksum,applied_at)
           VALUES (?,?,?)`,
        )
        .run(migration.name, migration.checksum, new Date().toISOString());
      const violations = foreignKeyViolations(sqlite);
      if (violations.length > 0)
        throw new Error(
          `Migration ${migration.name} introduced foreign key violations.`,
        );
    });
  }
  return inspectNodeMigrations(sqlite, directory);
}

function schemaSnapshot(sqlite: DatabaseSync) {
  return sqlite
    .prepare(
      `SELECT type,name,tbl_name,sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
    )
    .all();
}

function expectedSchema(directory: PathLike, applied: number) {
  const reference = new DatabaseSync(':memory:');
  migrateNodeDatabase(reference, directory, applied);
  const snapshot = schemaSnapshot(reference);
  reference.close();
  return snapshot;
}

export function verifyNodeDatabase(
  sqlite: DatabaseSync,
  directory: PathLike = migrationDirectory(),
  options: { allowPending?: boolean } = {},
) {
  const integrity = sqlite.prepare('PRAGMA quick_check').get() as
    | { quick_check?: unknown }
    | undefined;
  if (integrity?.quick_check !== 'ok')
    throw new Error('SQLite quick_check failed.');
  const violations = foreignKeyViolations(sqlite);
  if (violations.length > 0)
    throw new Error('SQLite foreign_key_check failed.');
  const status = inspectNodeMigrations(sqlite, directory);
  if (!status.tracked || status.legacy)
    throw new Error('Database does not have known migration history.');
  if (!options.allowPending && status.pending.length > 0)
    throw new Error('Database does not have the complete known migration history.');
  const actual = JSON.stringify(schemaSnapshot(sqlite));
  const expected = JSON.stringify(expectedSchema(directory, status.applied.length));
  if (actual !== expected)
    throw new Error(
      'Database schema differs from its recorded migration history.',
    );
  return status;
}
