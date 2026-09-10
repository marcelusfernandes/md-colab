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
];
const currentTables = [
  'd1_migrations',
  ...legacyTables,
  'publications',
  'publishing_tokens',
].sort();

const ids = {
  owner: '00000000-0000-4000-8000-000000000101',
  guest: '00000000-0000-4000-8000-000000000102',
  stranger: '00000000-0000-4000-8000-000000000103',
  document: '00000000-0000-4000-8000-000000000201',
  comment: '00000000-0000-4000-8000-000000000301',
  credential: '00000000-0000-4000-8000-000000000401',
  publication: '00000000-0000-4000-8000-000000000501',
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
INSERT INTO shares(document_id,email,name,created_at)
VALUES('${ids.document}','guest@example.test','Guest','2026-09-10T00:01:00.000Z');
INSERT INTO comments(id,document_id,author_id,body,quote,source_start,created_at)
VALUES('${ids.comment}','${ids.document}','${ids.guest}','Synthetic comment','Synthetic plan',2,'2026-09-10T00:02:00.000Z');
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
      (SELECT count(*) FROM comments) AS comments_count,
      (SELECT count(*) FROM shares) AS shares_count,
      (SELECT count(*) FROM publications) AS publications_count,
      (SELECT count(*) FROM publishing_tokens WHERE revoked_at IS NOT NULL) AS revoked_count,
      (SELECT owner_id FROM documents WHERE id='${ids.document}') AS owner_id,
      (SELECT author_id FROM comments WHERE id='${ids.comment}') AS comment_author_id,
      (SELECT publishing_token_id FROM publications WHERE id='${ids.publication}') AS publication_token_id,
      (SELECT title FROM documents WHERE id='${ids.document}') AS marker,
      EXISTS(SELECT 1 FROM shares WHERE document_id='${ids.document}' AND email='guest@example.test') AS guest_grant,
      EXISTS(SELECT 1 FROM shares WHERE document_id='${ids.document}' AND email='stranger@example.test') AS stranger_grant`,
  ).results;
  assert(rows.length === 1, 'Fixture nao retornou uma linha de verificacao.');
  const row = rows[0];
  assert(row.users_count === 3, 'Contagem de identidades divergente.');
  assert(row.documents_count === 1 && row.comments_count === 1, 'Plano/comentario divergentes.');
  assert(row.shares_count === 1 && row.publications_count === 1, 'Share/publicacao divergentes.');
  assert(row.revoked_count === 1, 'Credencial revogada ausente.');
  assert(row.owner_id === ids.owner, 'Propriedade do plano divergente.');
  assert(row.comment_author_id === ids.guest, 'Autoria do comentario divergente.');
  assert(row.publication_token_id === ids.credential, 'Relacao da publicacao divergente.');
  assert(row.marker === marker, 'Marcador do banco divergente.');
  assert(row.guest_grant === 1 && row.stranger_grant === 0, 'Permissoes sinteticas divergentes.');
  assert(foreignKeyViolations(environment).length === 0, 'foreign_key_check falhou.');
  return {
    users: row.users_count,
    documents: row.documents_count,
    comments: row.comments_count,
    shares: row.shares_count,
    publications: row.publications_count,
    revokedCredentials: row.revoked_count,
  };
}

function applyFilesManually(environment, files) {
  for (const file of files) executeFile(environment, join(migrationsDirectory, file));
  assert(ledger(environment) === null, 'Execucao manual criou ledger inesperado.');
}

function alteredDefaultMigration(outputDirectory) {
  const path = join(outputDirectory, '0002_altered_default.sql');
  privateFile(
    path,
    "ALTER TABLE `documents` ADD `is_test` integer DEFAULT 1 NOT NULL;\nALTER TABLE `users` ADD `test_email` text;\n",
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
    ) === JSON.stringify(currentTables.filter((table) => table !== 'd1_migrations')),
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
  const destination = createEnvironment(join(outputDirectory, 'restored'));
  executeFile(destination, schemaExportPath);
  executeFile(destination, dataExportPath);
  const restoredCounts = verifyFixture(destination);
  expectedLedger(destination);
  assert(
    fingerprint(schemaSnapshot(source)) === fingerprint(schemaSnapshot(destination)),
    'Schema restaurado diverge da origem.',
  );
  const restoredExportPath = join(outputDirectory, 'restored-reexport.sql');
  exportDatabase(destination, restoredExportPath);
  assert(digestFile(backupPath) === digestFile(restoredExportPath), 'Roundtrip SQL divergiu.');

  const legacy = createEnvironment(join(outputDirectory, 'legacy-0002'));
  applyFilesManually(legacy, currentMigrations.slice(0, 3));
  executeSql(
    legacy,
    "INSERT INTO users(id,email,name,test_email) VALUES('legacy-user','legacy@example.test','Legacy',NULL)",
  );
  const legacySchemaBeforeStatus = fingerprint(schemaSnapshot(legacy));
  const legacyStatus = localStatus(legacy);
  assert(!legacyStatus.tracked, 'Status criou ou encontrou ledger inesperado no legado.');
  assertRejected(
    () => migrateLocal(legacy),
    'Schema sem ledger rastreado',
  );
  assert(ledger(legacy) === null, 'Status/migrate recusado criou ledger no legado.');
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
  assert(legacyRows[0]?.count === 1, 'A adocao/upgrade nao preservou o dado legado.');
  assert(foreignKeyViolations(legacy).length === 0, 'FK do legado atualizado falhou.');

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
    "CREATE TRIGGER unexpected_trigger AFTER INSERT ON users BEGIN UPDATE users SET name=name WHERE id=NEW.id; END",
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

  const alteredDefault = createEnvironment(join(outputDirectory, 'negative-default'));
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
  assert(ledger(alteredDefault) === null, 'Negativo com default alterado recebeu ledger.');

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
    schemaSha256: fingerprint(schemaSnapshot(destination)),
    fixture: fixtureCounts,
    restoredFixture: restoredCounts,
    ledger: currentMigrations,
    negatives: [
      'partial',
      'extra-trigger',
      'sqlitex-extra',
      'altered-is_test-default',
    ],
    legacyAdoptedThrough: currentMigrations[2],
    legacyUpgradedThrough: currentMigrations[3],
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
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
