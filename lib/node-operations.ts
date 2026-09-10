import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';
import { openNodeSqlite } from './node-d1.ts';
import {
  inspectNodeMigrations,
  migrateNodeDatabase,
  migrationDirectory,
  verifyNodeDatabase,
} from './node-migrations.ts';

function distinctPaths(source: string, target: string) {
  const sourcePath = resolve(source);
  const targetPath = resolve(target);
  if (sourcePath === targetPath)
    throw new Error('Source and destination database paths must differ.');
  if (existsSync(targetPath))
    throw new Error(`Destination already exists at ${targetPath}.`);
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  return { sourcePath, targetPath };
}

async function fileSha256(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function removeIncomplete(path: string) {
  for (const candidate of [path, path + '-wal', path + '-shm'])
    rmSync(candidate, { force: true });
}

function tableExists(
  sqlite: ReturnType<typeof openNodeSqlite>['sqlite'],
  name: string,
) {
  return Boolean(
    sqlite
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
      .get(name),
  );
}

export async function backupNodeDatabase(
  databasePath: string,
  outputPath: string,
  options: { allowPending?: boolean; migrationsPath?: string } = {},
) {
  const { sourcePath, targetPath } = distinctPaths(databasePath, outputPath);
  const source = openNodeSqlite(sourcePath, { readOnly: true });
  try {
    const status = verifyNodeDatabase(
      source.sqlite,
      options.migrationsPath ?? migrationDirectory(),
      { allowPending: options.allowPending },
    );
    try {
      await sqliteBackup(source.sqlite, targetPath, { rate: 100 });
      chmodSync(targetPath, 0o600);
      const restored = openNodeSqlite(targetPath, { readOnly: true });
      try {
        verifyNodeDatabase(
          restored.sqlite,
          options.migrationsPath ?? migrationDirectory(),
          { allowPending: options.allowPending },
        );
      } finally {
        restored.sqlite.close();
      }
      return {
        path: targetPath,
        bytes: statSync(targetPath).size,
        sha256: await fileSha256(targetPath),
        applied: status.applied,
        pending: status.pending,
      };
    } catch (error) {
      removeIncomplete(targetPath);
      throw error;
    }
  } finally {
    source.sqlite.close();
  }
}

export async function restoreNodeDatabase(
  backupPath: string,
  outputPath: string,
  options: { migrationsPath?: string; now?: number } = {},
) {
  const { sourcePath, targetPath } = distinctPaths(backupPath, outputPath);
  const source = openNodeSqlite(sourcePath, { readOnly: true });
  try {
    verifyNodeDatabase(
      source.sqlite,
      options.migrationsPath ?? migrationDirectory(),
      { allowPending: true },
    );
    try {
      await sqliteBackup(source.sqlite, targetPath, { rate: 100 });
      chmodSync(targetPath, 0o600);
      const restored = openNodeSqlite(targetPath);
      let status: ReturnType<typeof verifyNodeDatabase>;
      let revokedShares = 0;
      let revokedCredentials = 0;
      try {
        verifyNodeDatabase(
          restored.sqlite,
          options.migrationsPath ?? migrationDirectory(),
          { allowPending: true },
        );
        restored.sqlite.exec('BEGIN IMMEDIATE');
        try {
          if (tableExists(restored.sqlite, 'shares'))
            revokedShares = Number(
              restored.sqlite.prepare('DELETE FROM shares').run().changes,
            );
          for (const table of ['magic_links', 'sessions', 'auth_limits'])
            if (tableExists(restored.sqlite, table))
              restored.sqlite.exec(`DELETE FROM "${table}"`);
          if (tableExists(restored.sqlite, 'publishing_tokens'))
            revokedCredentials = Number(
              restored.sqlite
                .prepare(
                  'UPDATE publishing_tokens SET revoked_at=COALESCE(revoked_at,?)',
                )
                .run(options.now ?? Math.floor(Date.now() / 1000)).changes,
            );
          restored.sqlite.exec('COMMIT');
        } catch (error) {
          restored.sqlite.exec('ROLLBACK');
          throw error;
        }
        status = verifyNodeDatabase(
          restored.sqlite,
          options.migrationsPath ?? migrationDirectory(),
          { allowPending: true },
        );
        restored.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        restored.sqlite.close();
      }
      const checked = openNodeSqlite(targetPath, { readOnly: true });
      try {
        verifyNodeDatabase(
          checked.sqlite,
          options.migrationsPath ?? migrationDirectory(),
          { allowPending: true },
        );
      } finally {
        checked.sqlite.close();
      }
      return {
        path: targetPath,
        bytes: statSync(targetPath).size,
        sha256: await fileSha256(targetPath),
        applied: status.applied,
        pending: status.pending,
        revokedShares,
        revokedCredentials,
        authenticationArtifactsCleared: true,
      };
    } catch (error) {
      removeIncomplete(targetPath);
      throw error;
    }
  } finally {
    source.sqlite.close();
  }
}

export function migrateNodePath(
  databasePath: string,
  migrationsPath = migrationDirectory(),
) {
  const opened = openNodeSqlite(databasePath, { create: true });
  try {
    const before = inspectNodeMigrations(opened.sqlite, migrationsPath);
    const after = migrateNodeDatabase(opened.sqlite, migrationsPath);
    verifyNodeDatabase(opened.sqlite, migrationsPath);
    return { path: opened.path, before, after };
  } finally {
    opened.sqlite.close();
  }
}
