#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyMigrations,
  createEnvironment,
  executeFile,
  executeSql,
  exportDatabase,
  fingerprint,
  foreignKeyViolations,
  inspectOrAdoptLegacy,
  legacyTables,
  ledger,
  localStatus,
  migrateLocal,
  migrationsDirectory,
  repositoryRoot,
  resolveNewEvidenceDirectory,
  schemaSnapshot,
} from './d1-local.mjs';

const currentMigrations = [
  '0000_mute_microchip.sql',
  '0001_email_access.sql',
  '0002_link_test_mode.sql',
  '0003_pink_blazing_skull.sql',
  '0004_polite_mandrill.sql',
  '0005_first_apocalypse.sql',
  '0006_hesitant_dazzler.sql',
  '0007_nifty_iron_man.sql',
  '0008_lethal_ultron.sql',
  '0009_slimy_kingpin.sql',
  '0010_serious_dazzler.sql',
  '0011_tiny_valeria_richards.sql',
];
const currentTables = [
  'd1_migrations',
  ...legacyTables,
  'publications',
  'publishing_tokens',
  'conversation_changes',
  'conversation_events',
  'notification_deliveries',
  'notification_events',
  'notification_reconciliations',
  'document_revisions',
].sort();

const ids = {
  owner: '00000000-0000-4000-8000-000000000101',
  guest: '00000000-0000-4000-8000-000000000102',
  stranger: '00000000-0000-4000-8000-000000000103',
  document: '00000000-0000-4000-8000-000000000201',
  comment: '00000000-0000-4000-8000-000000000301',
  credential: '00000000-0000-4000-8000-000000000401',
  publication: '00000000-0000-4000-8000-000000000501',
  revision2: '00000000-0000-4000-8000-000000000601',
  revision3: '00000000-0000-4000-8000-000000000602',
};

function privateFile(path, content) {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, content, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectedLedger(environment, names = currentMigrations) {
  const value = ledger(environment);
  assert(value, 'Ledger ausente.');
  assert(
    JSON.stringify(value.rows.map((row) => row.name)) === JSON.stringify(names),
    'Ledger nao corresponde as migracoes esperadas.',
  );
  return value.rows;
}

function assertRejected(action, message) {
  try {
    action();
  } catch (error) {
    assert(
      String(error).includes(message),
      `Rejeicao inesperada: ${String(error)}`,
    );
    return;
  }
  throw new Error(`Negativo nao foi recusado: ${message}`);
}

function fixtureSql(marker = 'source-marker') {
  const revokedHash = createHash('sha256')
    .update('synthetic-revoked-credential')
    .digest('hex');
  return `PRAGMA foreign_keys=ON;
INSERT INTO users(id,email,name,test_email) VALUES
('${ids.owner}','owner@example.test','Owner',NULL),
('${ids.guest}','guest@example.test','Guest',NULL),
('${ids.stranger}','stranger@example.test','Stranger',NULL);
INSERT INTO documents(id,owner_id,title,filename,markdown,is_test,created_at)
VALUES('${ids.document}','${ids.owner}','${marker}','plan.md','# Synthetic plan',0,'2026-09-10T00:00:00.000Z');
INSERT INTO document_revisions(id,document_id,ordinal,author_id,title,filename,markdown,created_at)
VALUES('${ids.document}','${ids.document}',1,'${ids.owner}','${marker}','plan.md','# Synthetic plan','2026-09-10T00:00:00.000Z');
UPDATE documents SET current_revision_id='${ids.document}' WHERE id='${ids.document}';
INSERT INTO shares(document_id,email,name,created_at)
VALUES('${ids.document}','guest@example.test','Guest','2026-09-10T00:01:00.000Z');
INSERT INTO comments(id,document_id,author_id,body,quote,source_start,source_revision_id,created_at)
VALUES('${ids.comment}','${ids.document}','${ids.guest}','Synthetic comment','Synthetic plan',2,'${ids.document}','2026-09-10T00:02:00.000Z');
INSERT INTO comments(id,document_id,author_id,body,quote,source_start,source_revision_id,created_at)
VALUES('${ids.comment}','${ids.document}','${ids.guest}','Synthetic comment','Synthetic plan',2,'${ids.document}','2026-09-10T00:02:00.000Z')
ON CONFLICT(id) DO NOTHING;
INSERT INTO document_revisions
  (id,document_id,ordinal,author_id,title,filename,markdown,base_revision_id,summary,considered_comment_ids,created_at)
VALUES
  ('${ids.revision2}','${ids.document}',2,'${ids.owner}','${marker}-v2','plan-v2.md','# Synthetic v2','${ids.document}','Considered guest feedback','["${ids.comment}"]','2026-09-10T00:02:30.000Z');
INSERT INTO document_revisions
  (id,document_id,ordinal,author_id,title,filename,markdown,base_revision_id,summary,considered_comment_ids,created_at)
VALUES
  ('${ids.revision3}','${ids.document}',3,'${ids.owner}','${marker}-v3','plan-v3.md','# Synthetic v3','${ids.revision2}',NULL,'[]','2026-09-10T00:02:45.000Z');
INSERT INTO magic_links(token_hash,email,document_id,comment_id,revision_id,expires_at,used_at)
VALUES
  ('synthetic-comment-link','guest@example.test','${ids.document}','${ids.comment}',NULL,1900000000,NULL),
  ('synthetic-revision-link','guest@example.test','${ids.document}',NULL,'${ids.revision2}',1900000000,NULL);
INSERT INTO publishing_tokens(id,user_id,name,token_hash,created_at,expires_at,revoked_at)
VALUES('${ids.credential}','${ids.owner}','Revoked synthetic credential','${revokedHash}','2026-09-10T00:03:00.000Z',1900000000,1789014000);
INSERT INTO publications(id,document_id,author_id,publishing_token_id,idempotency_key_hash,payload_digest,created_at)
VALUES('${ids.publication}','${ids.document}','${ids.owner}','${ids.credential}','synthetic-idempotency-hash','synthetic-payload-digest','2026-09-10T00:04:00.000Z');
`;
}

function verifyFixture(environment, marker = 'source-marker') {
  const rows = executeSql(
    environment,
    `SELECT
      (SELECT count(*) FROM users) AS users_count,
      (SELECT count(*) FROM documents) AS documents_count,
      (SELECT count(*) FROM document_revisions) AS revisions_count,
      (SELECT count(*) FROM comments) AS comments_count,
      (SELECT count(*) FROM shares) AS shares_count,
      (SELECT count(*) FROM publications) AS publications_count,
      (SELECT count(*) FROM publishing_tokens WHERE revoked_at IS NOT NULL) AS revoked_count,
      (SELECT count(*) FROM magic_links) AS magic_links_count,
      (SELECT owner_id FROM documents WHERE id='${ids.document}') AS owner_id,
      (SELECT author_id FROM comments WHERE id='${ids.comment}') AS comment_author_id,
      (SELECT sequence FROM comments WHERE id='${ids.comment}') AS comment_sequence,
      (SELECT source_revision_id FROM comments WHERE id='${ids.comment}') AS comment_revision_id,
      (SELECT publishing_token_id FROM publications WHERE id='${ids.publication}') AS publication_token_id,
      (SELECT title FROM documents WHERE id='${ids.document}') AS marker,
      (SELECT current_revision_id FROM documents WHERE id='${ids.document}') AS current_revision_id,
      (SELECT base_revision_id FROM document_revisions WHERE id='${ids.revision2}') AS revision2_base,
      (SELECT summary FROM document_revisions WHERE id='${ids.revision2}') AS revision2_summary,
      (SELECT considered_comment_ids FROM document_revisions WHERE id='${ids.revision2}') AS revision2_refs,
      (SELECT base_revision_id FROM document_revisions WHERE id='${ids.revision3}') AS revision3_base,
      (SELECT comment_id FROM magic_links WHERE token_hash='synthetic-comment-link') AS comment_link_comment_id,
      (SELECT revision_id FROM magic_links WHERE token_hash='synthetic-comment-link') AS comment_link_revision_id,
      (SELECT comment_id FROM magic_links WHERE token_hash='synthetic-revision-link') AS revision_link_comment_id,
      (SELECT revision_id FROM magic_links WHERE token_hash='synthetic-revision-link') AS revision_link_revision_id,
      EXISTS(SELECT 1 FROM shares WHERE document_id='${ids.document}' AND email='guest@example.test') AS guest_grant,
      EXISTS(SELECT 1 FROM shares WHERE document_id='${ids.document}' AND email='stranger@example.test') AS stranger_grant`,
  ).results;
  assert(rows.length === 1, 'Fixture nao retornou uma linha de verificacao.');
  const row = rows[0];
  assert(row.users_count === 3, 'Contagem de identidades divergente.');
  assert(
    row.documents_count === 1 && row.comments_count === 1,
    'Plano/comentario divergentes.',
  );
  assert(row.revisions_count === 3, 'Snapshots v1-v3 divergentes.');
  assert(
    row.shares_count === 1 && row.publications_count === 1,
    'Share/publicacao divergentes.',
  );
  assert(row.revoked_count === 1, 'Credencial revogada ausente.');
  assert(row.magic_links_count === 2, 'Destinos sinteticos de acesso divergentes.');
  assert(row.owner_id === ids.owner, 'Propriedade do plano divergente.');
  assert(
    row.comment_author_id === ids.guest,
    'Autoria do comentario divergente.',
  );
  assert(
    Number.isSafeInteger(row.comment_sequence) && row.comment_sequence > 0,
    'Sequencia persistida do comentario divergente.',
  );
  assert(
    row.comment_revision_id === ids.document,
    'Origem do comentario divergente.',
  );
  assert(
    row.publication_token_id === ids.credential,
    'Relacao da publicacao divergente.',
  );
  assert(row.marker === `${marker}-v3`, 'Projecao atual do banco divergente.');
  assert(
    row.current_revision_id === ids.revision3 &&
      row.revision2_base === ids.document &&
      row.revision2_summary === 'Considered guest feedback' &&
      row.revision2_refs === `["${ids.comment}"]` &&
      row.revision3_base === ids.revision2,
    'Base, resumo ou referencias dos snapshots v2/v3 divergentes.',
  );
  assert(
    row.comment_link_comment_id === ids.comment &&
      row.comment_link_revision_id === null &&
      row.revision_link_comment_id === null &&
      row.revision_link_revision_id === ids.revision2,
    'Destinos exclusivos de comentario/revisao divergentes.',
  );
  assert(
    row.guest_grant === 1 && row.stranger_grant === 0,
    'Permissoes sinteticas divergentes.',
  );
  assert(
    foreignKeyViolations(environment).length === 0,
    'foreign_key_check falhou.',
  );
  return {
    users: row.users_count,
    documents: row.documents_count,
    comments: row.comments_count,
    commentSequence: row.comment_sequence,
    shares: row.shares_count,
    publications: row.publications_count,
    revokedCredentials: row.revoked_count,
  };
}

function verifyNextCommentSequence(environment) {
  const previous = executeSql(
    environment,
    'SELECT max(sequence) AS sequence FROM comments',
  ).results[0]?.sequence;
  const nextId = '00000000-0000-4000-8000-000000000302';
  executeSql(
    environment,
    `INSERT INTO comments(id,document_id,author_id,body,quote,source_start,source_revision_id,created_at)
     VALUES('${nextId}','${ids.document}','${ids.owner}','After restore','',NULL,'${ids.document}','2026-09-10T00:05:00.000Z')`,
  );
  const next = executeSql(
    environment,
    `SELECT sequence FROM comments WHERE id='${nextId}'`,
  ).results[0]?.sequence;
  assert(
    Number.isSafeInteger(previous) &&
      Number.isSafeInteger(next) &&
      next > previous,
    'Nova insercao nao recebeu sequencia maior depois do restore.',
  );
  return { previous, next };
}

function applyFilesManually(environment, files) {
  for (const file of files)
    executeFile(environment, join(migrationsDirectory, file));
  assert(
    ledger(environment) === null,
    'Execucao manual criou ledger inesperado.',
  );
}

function alteredDefaultMigration(outputDirectory) {
  const path = join(outputDirectory, '0002_altered_default.sql');
  privateFile(
    path,
    'ALTER TABLE `documents` ADD `is_test` integer DEFAULT 1 NOT NULL;\nALTER TABLE `users` ADD `test_email` text;\n',
  );
  return path;
}

export function run(outputValue) {
  const outputDirectory = resolveNewEvidenceDirectory(outputValue);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

  const source = createEnvironment(join(outputDirectory, 'source'));
  applyMigrations(source);
  const firstLedger = expectedLedger(source);
  applyMigrations(source);
  assert(
    JSON.stringify(expectedLedger(source)) === JSON.stringify(firstLedger),
    'Repeticao alterou o ledger.',
  );
  const fixturePath = join(outputDirectory, 'fixture.sql');
  privateFile(fixturePath, fixtureSql());
  executeFile(source, fixturePath);
  const fixtureCounts = verifyFixture(source);
  assert(
    JSON.stringify(
      schemaSnapshot(source)
        .tables.map((table) => table.name)
        .sort(),
    ) ===
      JSON.stringify(
        currentTables.filter((table) => table !== 'd1_migrations'),
      ),
    'Tabela inesperada na origem; export allowlisted recusado.',
  );

  const control = createEnvironment(join(outputDirectory, 'isolation-control'));
  applyMigrations(control);
  const controlFixturePath = join(outputDirectory, 'control-fixture.sql');
  privateFile(controlFixturePath, fixtureSql('control-marker'));
  executeFile(control, controlFixturePath);
  verifyFixture(control, 'control-marker');

  const backupPath = join(outputDirectory, 'source-backup.sql');
  exportDatabase(source, backupPath);
  const schemaExportPath = join(outputDirectory, 'source-schema.sql');
  const dataExportPath = join(outputDirectory, 'source-data.sql');
  exportDatabase(source, schemaExportPath, { includeData: false });
  exportDatabase(source, dataExportPath, {
    includeSchema: false,
    tables: currentTables,
  });
  const schemaSql = readFileSync(schemaExportPath, 'utf8');
  const firstTrigger = schemaSql.indexOf('CREATE TRIGGER');
  assert(
    firstTrigger > 0,
    'Export de schema nao contem os triggers esperados.',
  );
  const restoreSchemaPath = join(outputDirectory, 'restore-schema.sql');
  const restoreTriggersPath = join(outputDirectory, 'restore-triggers.sql');
  privateFile(restoreSchemaPath, schemaSql.slice(0, firstTrigger));
  privateFile(restoreTriggersPath, schemaSql.slice(firstTrigger));
  const destination = createEnvironment(join(outputDirectory, 'restored'));
  executeFile(destination, restoreSchemaPath);
  executeFile(destination, dataExportPath);
  executeFile(destination, restoreTriggersPath);
  const restoredCounts = verifyFixture(destination);
  expectedLedger(destination);
  assert(
    fingerprint(schemaSnapshot(source)) ===
      fingerprint(schemaSnapshot(destination)),
    'Schema restaurado diverge da origem.',
  );
  const restoredExportPath = join(outputDirectory, 'restored-reexport.sql');
  exportDatabase(destination, restoredExportPath);
  const restoredDataExportPath = join(
    outputDirectory,
    'restored-data-reexport.sql',
  );
  exportDatabase(destination, restoredDataExportPath, {
    includeSchema: false,
    tables: currentTables,
  });
  assert(
    digestFile(dataExportPath) === digestFile(restoredDataExportPath),
    'Dados allowlisted divergiram no roundtrip.',
  );
  const restoredSequence = verifyNextCommentSequence(destination);

  const legacy = createEnvironment(join(outputDirectory, 'legacy-0002'));
  applyFilesManually(legacy, currentMigrations.slice(0, 3));
  executeSql(
    legacy,
    "INSERT INTO users(id,email,name,test_email) VALUES('legacy-user','legacy@example.test','Legacy',NULL)",
  );
  executeSql(
    legacy,
    `INSERT INTO documents(id,owner_id,title,filename,markdown,is_test,created_at)
     VALUES('legacy-document','legacy-user','Legacy','legacy.md','# Legacy',0,'2026-01-01T00:00:00.000Z')`,
  );
  executeSql(
    legacy,
    `INSERT INTO magic_links(token_hash,email,document_id,expires_at,used_at)
     VALUES('legacy-link','legacy@example.test','legacy-document',1900000000,NULL)`,
  );
  executeSql(
    legacy,
    `INSERT INTO comments(id,document_id,author_id,body,quote,source_start,created_at) VALUES
     ('ffffffff-ffff-4fff-8fff-ffffffffffff','legacy-document','legacy-user','second by id','quote b',2,'2026-01-02T00:00:00.000Z'),
     ('00000000-0000-4000-8000-000000000001','legacy-document','legacy-user','first by id','quote a',1,'2026-01-02T00:00:00.000Z'),
     ('11111111-1111-4111-8111-111111111111','legacy-document','legacy-user','earlier timestamp','quote c',3,'2026-01-01T00:00:00.000Z')`,
  );
  const legacyCommentsBefore = executeSql(
    legacy,
    `SELECT id,document_id,author_id,body,quote,source_start,created_at
     FROM comments ORDER BY created_at,id`,
  ).results;
  const legacyBytesBefore = executeSql(
    legacy,
    `SELECT hex(id) AS id,hex(document_id) AS document_id,
       hex(author_id) AS author_id,hex(body) AS body,hex(quote) AS quote,
       source_start,hex(created_at) AS created_at
     FROM comments ORDER BY created_at,id`,
  ).results;
  const legacySchemaBeforeStatus = fingerprint(schemaSnapshot(legacy));
  const legacyStatus = localStatus(legacy);
  assert(
    !legacyStatus.tracked,
    'Status criou ou encontrou ledger inesperado no legado.',
  );
  assertRejected(() => migrateLocal(legacy), 'Schema sem ledger rastreado');
  assert(
    ledger(legacy) === null,
    'Status/migrate recusado criou ledger no legado.',
  );
  assert(
    fingerprint(schemaSnapshot(legacy)) === legacySchemaBeforeStatus,
    'Status/migrate recusado alterou o schema legado.',
  );
  const legacyBeforeAdoption = executeSql(
    legacy,
    "SELECT email,name FROM users WHERE id='legacy-user'",
  ).results;
  assert(
    legacyBeforeAdoption[0]?.email === 'legacy@example.test' &&
      legacyBeforeAdoption[0]?.name === 'Legacy',
    'Status/migrate recusado alterou o dado legado.',
  );
  inspectOrAdoptLegacy({
    persistTo: legacy.statePath,
    evidenceDir: join(outputDirectory, 'legacy-adoption-evidence'),
    adopt: true,
  });
  applyMigrations(legacy);
  expectedLedger(legacy);
  const legacyRows = executeSql(
    legacy,
    "SELECT count(*) AS count FROM users WHERE id='legacy-user' AND email='legacy@example.test'",
  ).results;
  assert(
    legacyRows[0]?.count === 1,
    'A adocao/upgrade nao preservou o dado legado.',
  );
  const legacyCommentsAfter = executeSql(
    legacy,
    `SELECT id,document_id,author_id,body,quote,source_start,created_at
     FROM comments ORDER BY created_at,id`,
  ).results;
  const legacyBytesAfter = executeSql(
    legacy,
    `SELECT hex(id) AS id,hex(document_id) AS document_id,
       hex(author_id) AS author_id,hex(body) AS body,hex(quote) AS quote,
       source_start,hex(created_at) AS created_at
     FROM comments ORDER BY created_at,id`,
  ).results;
  assert(
    JSON.stringify(legacyCommentsAfter) ===
      JSON.stringify(legacyCommentsBefore) &&
      JSON.stringify(legacyBytesAfter) === JSON.stringify(legacyBytesBefore),
    'A migracao nao preservou exatamente os valores e bytes dos comentarios legados.',
  );
  const legacySequences = executeSql(
    legacy,
    'SELECT sequence,id FROM comments ORDER BY sequence',
  ).results;
  assert(
    JSON.stringify(legacySequences.map((row) => row.id)) ===
      JSON.stringify(legacyCommentsBefore.map((row) => row.id)) &&
      JSON.stringify(legacySequences.map((row) => row.sequence)) ===
        JSON.stringify([1, 2, 3]),
    'Backfill legado nao seguiu created_at,id.',
  );
  assert(
    foreignKeyViolations(legacy).length === 0,
    'FK do legado atualizado falhou.',
  );
  assert(
    executeSql(
      legacy,
      `SELECT count(*) AS count FROM magic_links
       WHERE token_hash='legacy-link' AND document_id='legacy-document'
         AND comment_id IS NULL AND revision_id IS NULL AND used_at IS NULL`,
    ).results[0]?.count === 1,
    'A migracao nao preservou o destino de documento do token legado.',
  );
  assert(
    executeSql(legacy, 'SELECT count(*) AS count FROM notification_events')
      .results[0]?.count === 0,
    'A migracao criou avisos retroativos para comentarios legados.',
  );
  assert(
    executeSql(
      legacy,
      `SELECT count(*) AS count FROM comments
       WHERE source_revision_id='legacy-document'`,
    ).results[0]?.count === 3 &&
      executeSql(
        legacy,
        `SELECT count(*) AS count FROM document_revisions
         WHERE id='legacy-document' AND document_id='legacy-document' AND ordinal=1
           AND markdown='# Legacy'`,
      ).results[0]?.count === 1,
    'A migracao nao vinculou comentarios ao snapshot inicial real.',
  );

  const partial = createEnvironment(join(outputDirectory, 'negative-partial'));
  applyFilesManually(partial, currentMigrations.slice(0, 1));
  assertRejected(
    () =>
      inspectOrAdoptLegacy({
        persistTo: partial.statePath,
        evidenceDir: join(outputDirectory, 'negative-partial-evidence'),
        adopt: true,
      }),
    'parcial ou divergente',
  );
  assert(ledger(partial) === null, 'Negativo parcial recebeu ledger.');

  const trigger = createEnvironment(join(outputDirectory, 'negative-trigger'));
  applyFilesManually(trigger, currentMigrations.slice(0, 3));
  executeSql(
    trigger,
    'CREATE TRIGGER unexpected_trigger AFTER INSERT ON users BEGIN UPDATE users SET name=name WHERE id=NEW.id; END',
  );
  assertRejected(
    () =>
      inspectOrAdoptLegacy({
        persistTo: trigger.statePath,
        evidenceDir: join(outputDirectory, 'negative-trigger-evidence'),
        adopt: true,
      }),
    'parcial ou divergente',
  );
  assert(ledger(trigger) === null, 'Negativo com trigger recebeu ledger.');

  const sqlitex = createEnvironment(join(outputDirectory, 'negative-sqlitex'));
  applyFilesManually(sqlitex, currentMigrations.slice(0, 3));
  executeSql(sqlitex, 'CREATE TABLE sqlitex_extra(id TEXT)');
  assertRejected(
    () =>
      inspectOrAdoptLegacy({
        persistTo: sqlitex.statePath,
        evidenceDir: join(outputDirectory, 'negative-sqlitex-evidence'),
        adopt: true,
      }),
    'parcial ou divergente',
  );
  assert(ledger(sqlitex) === null, 'Negativo sqlitex_extra recebeu ledger.');

  const alteredDefault = createEnvironment(
    join(outputDirectory, 'negative-default'),
  );
  applyFilesManually(alteredDefault, currentMigrations.slice(0, 2));
  executeFile(alteredDefault, alteredDefaultMigration(outputDirectory));
  assertRejected(
    () =>
      inspectOrAdoptLegacy({
        persistTo: alteredDefault.statePath,
        evidenceDir: join(outputDirectory, 'negative-default-evidence'),
        adopt: true,
      }),
    'parcial ou divergente',
  );
  assert(
    ledger(alteredDefault) === null,
    'Negativo com default alterado recebeu ledger.',
  );

  const summary = {
    node: process.version,
    wrangler: '4.92.0',
    sourceState: source.statePath,
    sourceConfig: source.configPath,
    restoredState: destination.statePath,
    restoredConfig: destination.configPath,
    backup: backupPath,
    backupSha256: digestFile(backupPath),
    schemaExportSha256: digestFile(schemaExportPath),
    dataExportSha256: digestFile(dataExportPath),
    restoredExportSha256: digestFile(restoredExportPath),
    restoredDataExportSha256: digestFile(restoredDataExportPath),
    schemaSha256: fingerprint(schemaSnapshot(destination)),
    fixture: fixtureCounts,
    restoredFixture: restoredCounts,
    restoredSequence,
    ledger: currentMigrations,
    negatives: [
      'partial',
      'extra-trigger',
      'sqlitex-extra',
      'altered-is_test-default',
    ],
    legacyAdoptedThrough: currentMigrations[2],
    legacyUpgradedThrough: currentMigrations.at(-1),
  };
  const summaryPath = join(outputDirectory, 'verification.json');
  privateFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  chmodSync(summaryPath, 0o600);
  return { summary, summaryPath };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--output-dir')
    throw new Error('Use --output-dir outputs/<diretorio-novo>.');
  const result = run(argv[1]);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      evidence: resolve(repositoryRoot, argv[1]),
      restoredState: result.summary.restoredState,
      restoredConfig: result.summary.restoredConfig,
      backupSha256: result.summary.backupSha256,
      schemaSha256: result.summary.schemaSha256,
      fixture: result.summary.fixture,
      ledgerCount: result.summary.ledger.length,
      negatives: result.summary.negatives,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
