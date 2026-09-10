import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  createNodeD1,
  openNodeSqlite,
  openPersistentD1,
} from '../lib/node-d1.ts';
import {
  inspectNodeMigrations,
  migrateNodeDatabase,
} from '../lib/node-migrations.ts';
import {
  backupNodeDatabase,
  restoreNodeDatabase,
} from '../lib/node-operations.ts';

function temporary(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'md-colab-node-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

void test('Node D1 batch rolls every statement back and enforces foreign keys', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    `PRAGMA foreign_keys=ON;
     CREATE TABLE parents(id TEXT PRIMARY KEY);
     CREATE TABLE children(
       id TEXT PRIMARY KEY,
       parent_id TEXT NOT NULL REFERENCES parents(id)
     )`,
  );
  const db = createNodeD1(sqlite);
  await assert.rejects(
    db.batch([
      db.prepare('INSERT INTO parents(id) VALUES(?)').bind('parent'),
      db
        .prepare('INSERT INTO children(id,parent_id) VALUES(?,?)')
        .bind('child', 'missing'),
    ]),
    /FOREIGN KEY constraint failed/,
  );
  assert.equal(
    sqlite.prepare('SELECT count(*) AS count FROM parents').get()?.count,
    0,
  );
  sqlite.close();
});

void test('Node migration ledger persists, is idempotent, and rejects unknown state', (t) => {
  const directory = temporary(t);
  const database = join(directory, 'persistent.sqlite');
  const opened = openNodeSqlite(database, { create: true });
  const first = migrateNodeDatabase(opened.sqlite);
  assert.deepEqual(first.pending, []);
  assert.equal(first.applied.length, 5);
  const second = migrateNodeDatabase(opened.sqlite);
  assert.deepEqual(second.applied, first.applied);
  opened.sqlite.close();

  const restarted = openPersistentD1(database);
  assert.equal(
    restarted.sqlite
      .prepare('SELECT count(*) AS count FROM _md_colab_migrations')
      .get()?.count,
    5,
  );
  restarted.sqlite.close();

  const legacyPath = join(directory, 'legacy.sqlite');
  const legacy = openNodeSqlite(legacyPath, { create: true });
  legacy.sqlite.exec('CREATE TABLE legacy_data(id TEXT PRIMARY KEY)');
  assert.throws(
    () => migrateNodeDatabase(legacy.sqlite),
    /refusing to adopt unknown legacy state/,
  );
  assert.equal(
    inspectNodeMigrations(legacy.sqlite).legacy,
    true,
  );
  legacy.sqlite.close();

  const divergent = openNodeSqlite(database);
  divergent.sqlite
    .prepare(
      `UPDATE _md_colab_migrations SET checksum='changed' WHERE sequence=1`,
    )
    .run();
  divergent.sqlite.close();
  assert.throws(
    () => openPersistentD1(database),
    /Migration ledger diverges/,
  );
});

function seedBeforeCommentsMigration(sqlite: DatabaseSync) {
  sqlite
    .prepare('INSERT INTO users(id,email,name) VALUES(?,?,?)')
    .run('owner', 'owner@example.test', 'Owner');
  sqlite
    .prepare(
      `INSERT INTO documents(
        id,owner_id,title,filename,markdown,created_at,is_test
      ) VALUES(?,?,?,?,?,?,0)`,
    )
    .run('doc', 'owner', 'Plan', 'plan.md', '# Plan', '2026-09-10T00:00:00Z');
  const insert = sqlite.prepare(
    `INSERT INTO comments(
      id,document_id,author_id,body,quote,source_start,created_at
    ) VALUES(?,?,?,?,?,?,?)`,
  );
  insert.run(
    'comment-b',
    'doc',
    'owner',
    'Second',
    '',
    null,
    '2026-09-10T00:00:02Z',
  );
  insert.run(
    'comment-a',
    'doc',
    'owner',
    'First',
    '',
    null,
    '2026-09-10T00:00:01Z',
  );
}

void test('comments migration and its ledger entry commit atomically', (t) => {
  const directory = temporary(t);
  const migrations = join(directory, 'drizzle');
  cpSync('drizzle', migrations, { recursive: true });

  const success = new DatabaseSync(join(directory, 'success.sqlite'));
  migrateNodeDatabase(success, migrations, 4);
  seedBeforeCommentsMigration(success);
  migrateNodeDatabase(success, migrations);
  const ordered = success
    .prepare('SELECT id,sequence FROM comments ORDER BY sequence')
    .all() as { id: string; sequence: number }[];
  assert.deepEqual(
    ordered.map((row) => [row.id, row.sequence]),
    [
      ['comment-a', 1],
      ['comment-b', 2],
    ],
  );
  success.close();

  appendFileSync(
    join(migrations, '0004_polite_mandrill.sql'),
    '\nINSERT INTO table_that_does_not_exist VALUES (1);\n',
  );
  const failure = new DatabaseSync(join(directory, 'failure.sqlite'));
  migrateNodeDatabase(failure, migrations, 4);
  seedBeforeCommentsMigration(failure);
  assert.throws(
    () => migrateNodeDatabase(failure, migrations),
    /no such table/,
  );
  assert.equal(
    failure
      .prepare('SELECT count(*) AS count FROM _md_colab_migrations')
      .get()?.count,
    4,
  );
  assert.equal(
    failure.prepare('SELECT count(*) AS count FROM comments').get()?.count,
    2,
  );
  assert.equal(
    failure
      .prepare("SELECT count(*) AS count FROM pragma_table_info('comments') WHERE name='sequence'")
      .get()?.count,
    0,
  );
  failure.close();
});

void test('restore is isolated and invalidates snapshot access artifacts', async (t) => {
  const directory = temporary(t);
  const sourcePath = join(directory, 'source.sqlite');
  const backupPath = join(directory, 'backup.sqlite');
  const restorePath = join(directory, 'restore.sqlite');
  const opened = openNodeSqlite(sourcePath, { create: true });
  migrateNodeDatabase(opened.sqlite);
  opened.sqlite.exec(`
    INSERT INTO users(id,email,name) VALUES
      ('owner','owner@example.test','Owner'),
      ('guest','guest@example.test','Guest');
    INSERT INTO documents(id,owner_id,title,filename,markdown,created_at,is_test)
      VALUES('doc','owner','Plan','plan.md','# Plan','2026-09-10T00:00:00Z',0);
    INSERT INTO shares(document_id,email,name,created_at)
      VALUES('doc','guest@example.test','Guest','2026-09-10T00:00:01Z');
    INSERT INTO comments(id,document_id,author_id,body,quote,source_start,created_at)
      VALUES('comment','doc','guest','Review','',NULL,'2026-09-10T00:00:02Z');
    INSERT INTO publishing_tokens(id,user_id,name,token_hash,created_at,expires_at,revoked_at)
      VALUES('credential','owner','CLI','hash','2026-09-10T00:00:00Z',9999999999,NULL);
    INSERT INTO publications(id,document_id,author_id,publishing_token_id,idempotency_key_hash,payload_digest,created_at)
      VALUES('publication','doc','owner','credential','key','payload','2026-09-10T00:00:03Z');
    INSERT INTO sessions(token_hash,user_id,expires_at)
      VALUES('session','guest',9999999999);
    INSERT INTO magic_links(token_hash,email,document_id,expires_at,used_at)
      VALUES('magic','guest@example.test','doc',9999999999,NULL);
    INSERT INTO auth_limits(scope,key_hash,expires_at,count)
      VALUES('request-ip','ip',9999999999,1);
  `);
  opened.sqlite.close();

  await backupNodeDatabase(sourcePath, backupPath);
  const source = openNodeSqlite(sourcePath);
  source.sqlite.exec(
    "DELETE FROM shares; UPDATE publishing_tokens SET revoked_at=1 WHERE id='credential'",
  );
  source.sqlite.close();

  const result = await restoreNodeDatabase(backupPath, restorePath, { now: 42 });
  assert.equal(result.revokedShares, 1);
  assert.equal(result.revokedCredentials, 1);
  assert.equal(statSync(restorePath).mode & 0o777, 0o600);

  const restored = openPersistentD1(restorePath);
  for (const table of ['shares', 'sessions', 'magic_links', 'auth_limits'])
    assert.equal(
      restored.sqlite
        .prepare(`SELECT count(*) AS count FROM "${table}"`)
        .get()?.count,
      0,
    );
  assert.equal(
    restored.sqlite
      .prepare("SELECT revoked_at FROM publishing_tokens WHERE id='credential'")
      .get()?.revoked_at,
    42,
  );
  assert.equal(
    restored.sqlite
      .prepare('SELECT count(*) AS count FROM publications')
      .get()?.count,
    1,
  );
  assert.deepEqual(restored.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  restored.sqlite.close();
});
