#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
export const repositoryRoot = resolve(dirname(scriptPath), '..');
export const outputsRoot = join(repositoryRoot, 'outputs');
export const migrationsDirectory = join(repositoryRoot, 'drizzle');
const projectConfig = join(repositoryRoot, 'wrangler.local.json');
const wrangler = join(repositoryRoot, 'node_modules', '.bin', 'wrangler');
const databaseBinding = 'DB';
const databaseId = '00000000-0000-4000-8000-000000000000';
const allowedPrefix = '0002_link_test_mode';
const prefixMigrations = [
  '0000_mute_microchip.sql',
  '0001_email_access.sql',
  '0002_link_test_mode.sql',
];
export const legacyTables = [
  'auth_limits',
  'comments',
  'documents',
  'magic_links',
  'sessions',
  'shares',
  'users',
];

process.umask(0o077);

export function usage() {
  return `Uso:
  node scripts/d1-local.mjs status --persist-to <ambiente>/.wrangler/state
  node scripts/d1-local.mjs migrate --persist-to <ambiente>/.wrangler/state
  node scripts/d1-local.mjs legacy --persist-to <ambiente>/.wrangler/state \\
    --evidence-dir outputs/<diretorio-novo> --through ${allowedPrefix} [--adopt]

Todos os comandos operam somente em D1 local. O caminho de persistencia precisa
ser .wrangler/state desta worktree ou de um ambiente novo dentro de outputs/.`;
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!['status', 'migrate', 'legacy'].includes(command))
    throw new Error('Comando ausente ou desconhecido.');
  const options = { command, adopt: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--adopt') {
      if (options.adopt) throw new Error('--adopt foi informado mais de uma vez.');
      options.adopt = true;
      continue;
    }
    if (!['--persist-to', '--evidence-dir', '--through'].includes(argument))
      throw new Error(`Opcao desconhecida ou proibida: ${argument}`);
    const value = rest[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`Valor ausente para ${argument}.`);
    const key = {
      '--persist-to': 'persistTo',
      '--evidence-dir': 'evidenceDir',
      '--through': 'through',
    }[argument];
    if (options[key]) throw new Error(`${argument} foi informado mais de uma vez.`);
    options[key] = value;
    index += 1;
  }
  if (!options.persistTo) throw new Error('--persist-to e obrigatorio.');
  if (command !== 'legacy' && (options.evidenceDir || options.through || options.adopt))
    throw new Error('Opcoes de legado so podem ser usadas com o comando legacy.');
  if (command === 'legacy') {
    if (!options.evidenceDir) throw new Error('--evidence-dir e obrigatorio.');
    if (options.through !== allowedPrefix)
      throw new Error(`Somente o prefixo conhecido ${allowedPrefix} pode ser adotado.`);
  }
  return options;
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export function assertNoSymlinkPath(path) {
  const absolute = resolve(path);
  const parsed = absolute.split(sep);
  let current = absolute.startsWith(sep) ? sep : parsed.shift();
  for (const part of parsed) {
    if (!part) continue;
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error(`Symlink recusado no caminho: ${current}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export function assertNoSymlinksBelow(path) {
  assertNoSymlinkPath(path);
  let root;
  try {
    root = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (root.isSymbolicLink()) throw new Error(`Symlink recusado: ${path}`);
  if (!root.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink recusado: ${child}`);
    if (entry.isDirectory()) assertNoSymlinksBelow(child);
  }
}

function pathExistsWithoutFollowing(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function resolvePersistencePath(value, { mustExist = false } = {}) {
  const statePath = resolve(repositoryRoot, value);
  const expectedSuffix = join('.wrangler', 'state');
  if (!statePath.endsWith(`${sep}${expectedSuffix}`))
    throw new Error('--persist-to precisa terminar em .wrangler/state.');
  const environmentRoot = dirname(dirname(statePath));
  const isProjectState = environmentRoot === repositoryRoot;
  if (!isProjectState && !isInside(outputsRoot, environmentRoot))
    throw new Error('Persistencia local precisa ficar nesta worktree, dentro de outputs/.');
  assertNoSymlinkPath(statePath);
  if (mustExist && !existsSync(statePath))
    throw new Error('A persistencia legada informada nao existe.');
  return { statePath, environmentRoot, isProjectState };
}

export function resolveNewEvidenceDirectory(value) {
  const path = resolve(repositoryRoot, value);
  if (!isInside(outputsRoot, path) || path === outputsRoot)
    throw new Error('--evidence-dir precisa ser um filho novo de outputs/.');
  assertNoSymlinkPath(path);
  if (pathExistsWithoutFollowing(path))
    throw new Error('--evidence-dir ja existe; escolha outro destino.');
  return path;
}

function writePrivateFileExclusive(path, content) {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, content, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function environmentConfig(environment, migrationPath = migrationsDirectory) {
  if (environment.isProjectState) return projectConfig;
  mkdirSync(environment.environmentRoot, { recursive: true, mode: 0o700 });
  const configPath = join(environment.environmentRoot, 'wrangler.local.json');
  assertNoSymlinkPath(configPath);
  const expected = {
    name: 'md-colab-d1-local-isolated',
    compatibility_date: '2026-09-09',
    d1_databases: [
      {
        binding: databaseBinding,
        database_name: 'md-colab-d1-local-isolated',
        database_id: databaseId,
        migrations_dir: migrationPath,
      },
    ],
  };
  const serialized = `${JSON.stringify(expected, null, 2)}\n`;
  if (pathExistsWithoutFollowing(configPath)) {
    if (readFileSync(configPath, 'utf8') !== serialized)
      throw new Error(`Configuracao local divergente recusada: ${configPath}`);
  } else {
    writePrivateFileExclusive(configPath, serialized);
  }
  return configPath;
}

export function runWrangler(arguments_, { configPath, allowFailure = false } = {}) {
  if (!existsSync(wrangler)) throw new Error('Wrangler local ausente; execute npm ci.');
  const args = [...arguments_];
  if (configPath) args.push('--config', configPath);
  const result = spawnSync(wrangler, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: 'true',
      WRANGLER_SEND_METRICS: 'false',
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  const response = {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (!response.ok && !allowFailure) {
    const detail = response.stderr.trim().split('\n').slice(-3).join(' ');
    throw new Error(`Wrangler falhou (${args.slice(0, 3).join(' ')}): ${detail}`);
  }
  return response;
}

function assertSafeEnvironment(environment) {
  assertNoSymlinksBelow(environment.statePath);
  assertNoSymlinkPath(environment.configPath);
}

function localArguments(operation, environment, extra = []) {
  return [
    'd1',
    ...operation,
    databaseBinding,
    '--local',
    '--persist-to',
    environment.statePath,
    ...extra,
  ];
}

export function createEnvironment(environmentRoot, migrationPath = migrationsDirectory) {
  const root = resolve(environmentRoot);
  assertNoSymlinkPath(root);
  if (existsSync(root)) throw new Error(`Destino ja existe: ${root}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const environment = resolvePersistencePath(join(root, '.wrangler', 'state'));
  const configPath = environmentConfig(environment, migrationPath);
  return { ...environment, configPath };
}

export function openEnvironment(stateValue, { mustExist = false } = {}) {
  const environment = resolvePersistencePath(stateValue, { mustExist });
  return { ...environment, configPath: environmentConfig(environment) };
}

export function executeSql(environment, sql, { allowFailure = false } = {}) {
  assertSafeEnvironment(environment);
  const result = runWrangler(
    localArguments(['execute'], environment, ['--command', sql, '--json']),
    { configPath: environment.configPath, allowFailure },
  );
  if (!result.ok) return result;
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('Wrangler retornou JSON local invalido.');
  }
  return { ...result, results: parsed.flatMap((entry) => entry.results ?? []) };
}

export function executeFile(environment, file) {
  assertSafeEnvironment(environment);
  return runWrangler(
    localArguments(['execute'], environment, ['--file', file, '--yes']),
    { configPath: environment.configPath },
  );
}

export function applyMigrations(environment) {
  assertSafeEnvironment(environment);
  return runWrangler(localArguments(['migrations', 'apply'], environment), {
    configPath: environment.configPath,
  });
}

function applicationObjects(environment) {
  return executeSql(
    environment,
    `SELECT type,name FROM sqlite_schema
     WHERE name NOT GLOB 'sqlite_*'
       AND name NOT IN ('d1_migrations', '_cf_METADATA')
     ORDER BY type,name`,
  ).results;
}

export function localStatus(environment) {
  const migrationLedger = ledger(environment);
  const objects = applicationObjects(environment);
  return {
    statePath: environment.statePath,
    tracked: migrationLedger !== null,
    migrationCount: migrationLedger?.rows.length ?? 0,
    objectCount: objects.length,
  };
}

export function migrateLocal(environment) {
  const status = localStatus(environment);
  if (status.objectCount > 0 && (!status.tracked || status.migrationCount === 0))
    throw new Error(
      'Schema sem ledger rastreado; migrate recusado. Use o diagnostico legacy.',
    );
  return applyMigrations(environment);
}

export function exportDatabase(
  environment,
  output,
  { includeSchema = true, includeData = true, tables = [] } = {},
) {
  if (!includeSchema && !includeData)
    throw new Error('Export precisa incluir schema, dados ou ambos.');
  assertSafeEnvironment(environment);
  assertNoSymlinkPath(output);
  if (pathExistsWithoutFollowing(output)) throw new Error(`Backup ja existe: ${output}`);
  const selection = [
    ...(includeSchema ? [] : ['--no-schema']),
    ...(includeData ? [] : ['--no-data']),
    ...tables.flatMap((table) => ['--table', table]),
  ];
  const result = runWrangler(
    [
      'd1',
      'export',
      databaseBinding,
      '--local',
      '--output',
      output,
      '--skip-confirmation',
      ...selection,
    ],
    { configPath: environment.configPath },
  );
  chmodSync(output, 0o600);
  return result;
}

function quoteSql(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function ledger(environment) {
  const table = executeSql(
    environment,
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='d1_migrations'",
  ).results;
  if (table.length === 0) return null;
  const rows = executeSql(environment, 'SELECT * FROM d1_migrations ORDER BY id').results;
  return { createSql: table[0].sql, rows };
}

export function schemaSnapshot(environment) {
  const objects = executeSql(
    environment,
    `SELECT type,name,tbl_name,sql FROM sqlite_schema
     WHERE name NOT GLOB 'sqlite_*'
       AND name NOT IN ('d1_migrations', '_cf_METADATA')
     ORDER BY type,name`,
  ).results;
  const condition = `m.type='table' AND m.name NOT GLOB 'sqlite_*'
    AND m.name NOT IN ('d1_migrations', '_cf_METADATA')`;
  const columns = executeSql(
    environment,
    `SELECT m.name AS table_name,p.cid,p.name,p.type,
       p."notnull" AS not_null,p.dflt_value,p.pk
     FROM sqlite_schema m JOIN pragma_table_info(m.name) p
     WHERE ${condition} ORDER BY m.name,p.cid`,
  ).results;
  const indexes = executeSql(
    environment,
    `SELECT m.name AS table_name,il.seq,il.name AS index_name,
       il."unique" AS is_unique,il.origin,il.partial,
       ix.seqno,ix.cid,ix.name AS column_name,ix.desc,ix.coll,ix.key
     FROM sqlite_schema m
     JOIN pragma_index_list(m.name) il
     JOIN pragma_index_xinfo(il.name) ix
     WHERE ${condition} ORDER BY m.name,il.seq,ix.seqno`,
  ).results;
  const foreignKeys = executeSql(
    environment,
    `SELECT m.name AS table_name,f.id,f.seq,
       f."table" AS referenced_table,f."from" AS from_column,
       f."to" AS to_column,f.on_update,f.on_delete,f."match"
     FROM sqlite_schema m JOIN pragma_foreign_key_list(m.name) f
     WHERE ${condition} ORDER BY m.name,f.id,f.seq`,
  ).results;
  return {
    objects,
    tables: objects
      .filter((object) => object.type === 'table')
      .map((object) => ({ name: object.name })),
    columns,
    indexes,
    foreignKeys,
  };
}

export function foreignKeyViolations(environment) {
  return executeSql(environment, 'PRAGMA foreign_key_check').results;
}

export function fingerprint(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fileDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function createReference(evidenceDirectory) {
  const migrationPath = join(evidenceDirectory, 'reference', 'drizzle');
  mkdirSync(migrationPath, { recursive: true, mode: 0o700 });
  for (const file of prefixMigrations)
    copyFileSync(join(migrationsDirectory, file), join(migrationPath, file));
  const reference = createEnvironment(join(evidenceDirectory, 'reference', 'environment'), migrationPath);
  applyMigrations(reference);
  return reference;
}

function adoptionSql(referenceLedger) {
  if (!referenceLedger?.createSql || referenceLedger.rows.length !== prefixMigrations.length)
    throw new Error('Ledger de referencia inesperado; adocao recusada.');
  const statements = [referenceLedger.createSql];
  for (const row of referenceLedger.rows) {
    const columns = Object.keys(row);
    statements.push(
      `INSERT INTO d1_migrations (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${columns.map((column) => quoteSql(row[column])).join(',')})`,
    );
  }
  return `${statements.join(';\n')};\n`;
}

export function inspectOrAdoptLegacy({ persistTo, evidenceDir, adopt }) {
  const target = openEnvironment(persistTo, { mustExist: true });
  const evidenceDirectory = resolveNewEvidenceDirectory(evidenceDir);
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const reference = createReference(evidenceDirectory);
  const referenceLedger = ledger(reference);
  const initialLedger = ledger(target);
  if (initialLedger)
    throw new Error('O banco ja possui ledger; use status/migrate, nao adocao legada.');
  const expectedSchema = schemaSnapshot(reference);
  const initialSchema = schemaSnapshot(target);
  if (!sameJson(initialSchema, expectedSchema))
    throw new Error('Schema legado parcial ou divergente; adocao recusada sem alterar dados.');
  if (foreignKeyViolations(target).length !== 0)
    throw new Error('foreign_key_check encontrou violacoes; adocao recusada.');

  const report = {
    prefix: allowedPrefix,
    targetState: target.statePath,
    schemaFingerprint: fingerprint(initialSchema),
    objectCount: initialSchema.objects.length,
    foreignKeyCount: initialSchema.foreignKeys.length,
    adopted: false,
  };
  const reportPath = join(evidenceDirectory, 'inspection.json');
  writePrivateFileExclusive(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!adopt) return { report, reportPath };

  const backupPath = join(evidenceDirectory, 'pre-adoption-backup.sql');
  exportDatabase(target, backupPath);
  const backupDigest = fileDigest(backupPath);
  const backupSchemaPath = join(evidenceDirectory, 'pre-adoption-schema.sql');
  const backupDataPath = join(evidenceDirectory, 'pre-adoption-data.sql');
  exportDatabase(target, backupSchemaPath, { includeData: false });
  exportDatabase(target, backupDataPath, {
    includeSchema: false,
    tables: legacyTables,
  });
  const restoreProbe = createEnvironment(
    join(evidenceDirectory, 'backup-restore-probe'),
  );
  executeFile(restoreProbe, backupSchemaPath);
  executeFile(restoreProbe, backupDataPath);
  if (foreignKeyViolations(restoreProbe).length !== 0)
    throw new Error('Backup restaurado falhou no foreign_key_check; adocao recusada.');
  if (!sameJson(schemaSnapshot(restoreProbe), initialSchema))
    throw new Error('Backup restaurado nao reproduz o schema legado; adocao recusada.');
  const restoreCheckPath = join(evidenceDirectory, 'backup-restore-check.sql');
  exportDatabase(restoreProbe, restoreCheckPath);
  if (fileDigest(restoreCheckPath) !== backupDigest)
    throw new Error('Backup restaurado nao reproduz os dados legados; adocao recusada.');

  const targetRecheckPath = join(evidenceDirectory, 'target-recheck.sql');
  exportDatabase(target, targetRecheckPath);
  const schemaAfterBackup = schemaSnapshot(target);
  if (
    fileDigest(targetRecheckPath) !== backupDigest ||
    !sameJson(initialSchema, schemaAfterBackup) ||
    foreignKeyViolations(target).length !== 0 ||
    ledger(target)
  )
    throw new Error('O banco mudou durante a adocao; ledger nao foi escrito.');

  const sqlPath = join(evidenceDirectory, 'adopt-ledger.sql');
  writePrivateFileExclusive(sqlPath, adoptionSql(referenceLedger));
  executeFile(target, sqlPath);
  const adoptedLedger = ledger(target);
  if (!adoptedLedger || !sameJson(adoptedLedger.rows, referenceLedger.rows))
    throw new Error('Ledger adotado nao corresponde ao prefixo validado.');
  report.adopted = true;
  report.migrationCount = adoptedLedger.rows.length;
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return { report, reportPath, backupPath };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.command === 'legacy') {
    const result = inspectOrAdoptLegacy(options);
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
    return;
  }
  const environment = openEnvironment(options.persistTo);
  if (options.command === 'status') {
    process.stdout.write(`${JSON.stringify(localStatus(environment))}\n`);
    return;
  }
  const result = migrateLocal(environment);
  process.stdout.write(result.stdout);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
  }
}
