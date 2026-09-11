import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
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
  assert.equal(first.applied.length, 13);
  const second = migrateNodeDatabase(opened.sqlite);
  assert.deepEqual(second.applied, first.applied);
  opened.sqlite.close();

  const restarted = openPersistentD1(database);
  assert.equal(
    restarted.sqlite
      .prepare('SELECT count(*) AS count FROM _md_colab_migrations')
      .get()?.count,
    13,
  );
  restarted.sqlite.close();

  const legacyPath = join(directory, 'legacy.sqlite');
  const legacy = openNodeSqlite(legacyPath, { create: true });
  legacy.sqlite.exec('CREATE TABLE legacy_data(id TEXT PRIMARY KEY)');
  assert.throws(
    () => migrateNodeDatabase(legacy.sqlite),
    /refusing to adopt unknown legacy state/,
  );
  assert.equal(inspectNodeMigrations(legacy.sqlite).legacy, true);
  legacy.sqlite.close();

  const divergent = openNodeSqlite(database);
  divergent.sqlite
    .prepare(
      `UPDATE _md_colab_migrations SET checksum='changed' WHERE sequence=1`,
    )
    .run();
  divergent.sqlite.close();
  assert.throws(() => openPersistentD1(database), /Migration ledger diverges/);
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
    .prepare(
      'SELECT id,root_id,source_revision_id,sequence FROM comments ORDER BY sequence',
    )
    .all() as {
    id: string;
    root_id: string;
    source_revision_id: string;
    sequence: number;
  }[];
  assert.deepEqual(
    ordered.map((row) => [
      row.id,
      row.root_id,
      row.source_revision_id,
      row.sequence,
    ]),
    [
      ['comment-a', 'comment-a', 'doc', 1],
      ['comment-b', 'comment-b', 'doc', 2],
    ],
  );
  assert.deepEqual(
    {
      ...(success
        .prepare(
          `SELECT id,document_id,ordinal,author_id,title,filename,markdown,created_at
           FROM document_revisions WHERE id='doc'`,
        )
        .get() as Record<string, unknown>),
    },
    {
      id: 'doc',
      document_id: 'doc',
      ordinal: 1,
      author_id: 'owner',
      title: 'Plan',
      filename: 'plan.md',
      markdown: '# Plan',
      created_at: '2026-09-10T00:00:00Z',
    },
  );
  assert.equal(
    success.prepare('SELECT count(*) AS count FROM conversation_events').get()
      ?.count,
    0,
  );
  assert.equal(
    success.prepare('SELECT count(*) AS count FROM conversation_changes').get()
      ?.count,
    0,
  );
  success
    .prepare(
      `INSERT INTO comments(id,document_id,author_id,body,quote,source_start,source_revision_id,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    )
    .run(
      'legacy-writer',
      'doc',
      'owner',
      'Legacy writer',
      '',
      null,
      'doc',
      '2026-09-10T00:00:03Z',
    );
  const legacyChange = success
    .prepare(
      `SELECT c.root_id,changes.root_id AS changed_root
       FROM comments c JOIN conversation_changes changes ON changes.root_id=c.id
       WHERE c.id='legacy-writer'`,
    )
    .get();
  assert.equal(legacyChange?.root_id, 'legacy-writer');
  assert.equal(legacyChange?.changed_root, 'legacy-writer');
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
    failure.prepare('SELECT count(*) AS count FROM _md_colab_migrations').get()
      ?.count,
    4,
  );
  assert.equal(
    failure.prepare('SELECT count(*) AS count FROM comments').get()?.count,
    2,
  );
  assert.equal(
    failure
      .prepare(
        "SELECT count(*) AS count FROM pragma_table_info('comments') WHERE name='sequence'",
      )
      .get()?.count,
    0,
  );
  failure.close();
});

void test('revision backfill preserves comment, conversation, cursor and outbox rows in place', (t) => {
  const directory = temporary(t);
  const sqlite = new DatabaseSync(join(directory, 'revision-backfill.sqlite'));
  migrateNodeDatabase(sqlite, undefined, 9);
  sqlite.exec(`
    INSERT INTO users(id,email,name) VALUES
      ('owner','owner@example.test','Owner'),
      ('guest','guest@example.test','Guest');
    INSERT INTO documents(id,owner_id,title,filename,markdown,created_at,is_test)
      VALUES('doc','owner','Plan','plan.md','# Plan\r\n\r\nOriginal.\r\n','2026-09-10T00:00:00.000Z',0);
    INSERT INTO shares(document_id,email,name,created_at)
      VALUES('doc','guest@example.test','Guest','2026-09-10T00:00:01.000Z');
    INSERT INTO comments(id,document_id,author_id,body,quote,source_start,root_id,created_at)
      VALUES('comment','doc','guest','Critique','Original',10,'comment','2026-09-10T00:00:02.000Z');
    INSERT INTO conversation_events(
      id,document_id,root_id,actor_id,base_version,version,action,state,
      decision,decision_reason,reason,created_at
    ) VALUES(
      'event','doc','comment','owner',0,1,'follow','open','follow','Apply',NULL,
      '2026-09-10T00:00:03.000Z'
    );
  `);
  const originalDeliveryId = String(
    sqlite.prepare('SELECT id FROM notification_deliveries').get()?.id,
  );
  sqlite
    .prepare(
      `UPDATE notification_deliveries SET status='blocked',available_at=17,
         attempts=3,first_attempt_at=11,uncertain=1,
         idempotency_key='frozen-key-1',payload='{"frozen":"payload-1"}',
         last_error_code='uncertain_timeout',last_error_at=16
       WHERE id=?`,
    )
    .run(originalDeliveryId);
  sqlite
    .prepare(
      `INSERT INTO notification_reconciliations(
         action_id,delivery_id,operator_id,evidence,note,result_delivery_id,created_at
       ) VALUES('action',?,'operator','confirmed_not_delivered','Provider rejected.',
         'retry-delivery','2026-09-10T00:00:04.000Z')`,
    )
    .run(originalDeliveryId);
  sqlite
    .prepare(
      `UPDATE notification_deliveries SET status='leased',available_at=23,
         lease_token='frozen-lease',lease_expires_at=91,attempts=2,
         first_attempt_at=22,uncertain=1,idempotency_key='frozen-key-2',
         payload='{"frozen":"payload-2"}',last_error_code='provider_network',
         last_error_at=24 WHERE id='retry-delivery'`,
    )
    .run();
  const tables = [
    'comments',
    'conversation_changes',
    'conversation_events',
    'notification_events',
    'notification_deliveries',
    'notification_reconciliations',
  ];
  const before = new Map(
    tables.map((table) => [
      table,
      JSON.stringify(sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()),
    ]),
  );
  migrateNodeDatabase(sqlite);
  for (const table of tables) {
    const columns =
      table === 'comments'
        ? 'sequence,id,document_id,author_id,body,quote,source_start,created_at,root_id'
        : table === 'notification_events'
          ? 'id,comment_id,document_id,root_id,actor_id,created_at'
          : '*';
    const previous =
      table === 'comments'
        ? JSON.stringify(
            JSON.parse(before.get(table)!).map(
              ({
                source_revision_id: _source,
                ...row
              }: Record<string, unknown>) => row,
            ),
          )
        : before.get(table);
    assert.equal(
      JSON.stringify(
        sqlite.prepare(`SELECT ${columns} FROM ${table} ORDER BY 1`).all(),
      ),
      previous,
      `${table} mudou durante o backfill`,
    );
  }
  assert.deepEqual(
    sqlite
      .prepare('SELECT kind,revision_id FROM notification_events ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [{ kind: 'comment', revision_id: null }],
  );
  assert.equal(
    sqlite
      .prepare(
        `SELECT count(*) AS count FROM comments
         WHERE source_revision_id='doc'`,
      )
      .get()?.count,
    1,
  );
  assert.deepEqual(
    {
      ...(sqlite
        .prepare(
          `SELECT id,document_id,ordinal,author_id,title,filename,markdown,created_at
           FROM document_revisions`,
        )
        .get() as Record<string, unknown>),
    },
    {
      id: 'doc',
      document_id: 'doc',
      ordinal: 1,
      author_id: 'owner',
      title: 'Plan',
      filename: 'plan.md',
      markdown: '# Plan\r\n\r\nOriginal.\r\n',
      created_at: '2026-09-10T00:00:00.000Z',
    },
  );
  migrateNodeDatabase(sqlite);
  assert.equal(
    sqlite.prepare('SELECT count(*) AS count FROM document_revisions').get()
      ?.count,
    1,
  );
  sqlite.close();
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

  const result = await restoreNodeDatabase(backupPath, restorePath, {
    now: 42,
  });
  assert.equal(result.revokedShares, 1);
  assert.equal(result.revokedCredentials, 1);
  assert.equal(statSync(restorePath).mode & 0o777, 0o600);
  assert.equal(
    result.sha256,
    createHash('sha256').update(readFileSync(restorePath)).digest('hex'),
  );

  const restored = openPersistentD1(restorePath);
  for (const table of ['shares', 'sessions', 'magic_links', 'auth_limits'])
    assert.equal(
      restored.sqlite.prepare(`SELECT count(*) AS count FROM "${table}"`).get()
        ?.count,
      0,
    );
  assert.equal(
    restored.sqlite
      .prepare("SELECT revoked_at FROM publishing_tokens WHERE id='credential'")
      .get()?.revoked_at,
    42,
  );
  assert.equal(
    restored.sqlite.prepare('SELECT count(*) AS count FROM publications').get()
      ?.count,
    1,
  );
  assert.deepEqual(
    restored.sqlite.prepare('PRAGMA foreign_key_check').all(),
    [],
  );
  restored.sqlite.close();
});

void test('a verified pre-upgrade backup restores separately and requires explicit migration', async (t) => {
  const directory = temporary(t);
  const activePath = join(directory, 'active.sqlite');
  const backupPath = join(directory, 'pre-0004.sqlite');
  const restorePath = join(directory, 'restored.sqlite');
  const active = openNodeSqlite(activePath, { create: true });
  migrateNodeDatabase(active.sqlite, undefined, 4);
  active.sqlite.exec(`
    INSERT INTO users(id,email,name) VALUES
      ('owner','owner@example.test','Owner'),
      ('guest','guest@example.test','Guest');
    INSERT INTO documents(id,owner_id,title,filename,markdown,created_at,is_test)
      VALUES('doc','owner','Plan','plan.md','# Plan','2026-09-10T00:00:00Z',0);
    INSERT INTO shares(document_id,email,name,created_at)
      VALUES('doc','guest@example.test','Guest','2026-09-10T00:00:01Z');
    INSERT INTO publishing_tokens(id,user_id,name,token_hash,created_at,expires_at,revoked_at)
      VALUES('credential','owner','CLI','hash','2026-09-10T00:00:00Z',9999999999,NULL);
    INSERT INTO publications(id,document_id,author_id,publishing_token_id,idempotency_key_hash,payload_digest,created_at)
      VALUES('publication','doc','owner','credential','key','payload','2026-09-10T00:00:03Z');
    INSERT INTO sessions(token_hash,user_id,expires_at)
      VALUES('session','guest',9999999999);
  `);
  active.sqlite.close();

  const backup = await backupNodeDatabase(activePath, backupPath, {
    allowPending: true,
  });
  assert.deepEqual(backup.pending, [
    '0004_polite_mandrill',
    '0005_first_apocalypse',
    '0006_hesitant_dazzler',
    '0007_nifty_iron_man',
    '0008_lethal_ultron',
    '0009_slimy_kingpin',
    '0010_serious_dazzler',
    '0011_tiny_valeria_richards',
    '0012_previous_lifeguard',
  ]);
  const upgraded = openNodeSqlite(activePath);
  migrateNodeDatabase(upgraded.sqlite);
  upgraded.sqlite.close();

  const result = await restoreNodeDatabase(backupPath, restorePath, {
    now: 42,
  });
  assert.deepEqual(result.applied, [
    '0000_mute_microchip',
    '0001_email_access',
    '0002_link_test_mode',
    '0003_pink_blazing_skull',
  ]);
  assert.deepEqual(result.pending, [
    '0004_polite_mandrill',
    '0005_first_apocalypse',
    '0006_hesitant_dazzler',
    '0007_nifty_iron_man',
    '0008_lethal_ultron',
    '0009_slimy_kingpin',
    '0010_serious_dazzler',
    '0011_tiny_valeria_richards',
    '0012_previous_lifeguard',
  ]);
  assert.throws(
    () => openPersistentD1(restorePath),
    /complete known migration history/,
  );

  const restored = openNodeSqlite(restorePath);
  assert.equal(
    restored.sqlite.prepare('SELECT count(*) AS count FROM shares').get()
      ?.count,
    0,
  );
  assert.equal(
    restored.sqlite.prepare('SELECT count(*) AS count FROM sessions').get()
      ?.count,
    0,
  );
  assert.equal(
    restored.sqlite
      .prepare("SELECT revoked_at FROM publishing_tokens WHERE id='credential'")
      .get()?.revoked_at,
    42,
  );
  migrateNodeDatabase(restored.sqlite);
  restored.sqlite.close();

  const ready = openPersistentD1(restorePath);
  assert.deepEqual(inspectNodeMigrations(ready.sqlite).pending, []);
  ready.sqlite.close();

  const snapshot = openNodeSqlite(backupPath, { readOnly: true });
  assert.equal(
    snapshot.sqlite.prepare('SELECT count(*) AS count FROM shares').get()
      ?.count,
    1,
  );
  assert.equal(
    snapshot.sqlite
      .prepare("SELECT revoked_at FROM publishing_tokens WHERE id='credential'")
      .get()?.revoked_at,
    null,
  );
  snapshot.sqlite.close();
});
