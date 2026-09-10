import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const root = process.cwd();
const script = join(root, 'scripts', 'd1-local.mjs');

function invoke(...arguments_: string[]) {
  return spawnSync(process.execPath, [script, ...arguments_], {
    cwd: root,
    encoding: 'utf8',
  });
}

void test('helper local exige persistencia explicita e recusa flags remotas', () => {
  const missing = invoke('status');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--persist-to e obrigatorio/);

  const remote = invoke(
    'status',
    '--persist-to',
    'outputs/guard-test/.wrangler/state',
    '--remote',
  );
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /Opcao desconhecida ou proibida: --remote/);
});

void test('adocao aceita somente o prefixo historico conhecido', () => {
  const result = invoke(
    'legacy',
    '--persist-to',
    'outputs/guard-test/.wrangler/state',
    '--evidence-dir',
    'outputs/guard-test-evidence',
    '--through',
    '0001_email_access',
    '--adopt',
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Somente o prefixo conhecido 0002_link_test_mode/);
});

void test('helper recusa symlink pendente e symlink abaixo da persistencia', (t) => {
  const fixture = join(root, 'outputs', `guard-test-${process.pid}`);
  mkdirSync(fixture, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  const danglingEnvironment = join(fixture, 'dangling-environment');
  symlinkSync(join(fixture, 'missing-target'), danglingEnvironment);
  const dangling = invoke(
    'status',
    '--persist-to',
    join(danglingEnvironment, '.wrangler', 'state'),
  );
  assert.equal(dangling.status, 1);
  assert.match(dangling.stderr, /Symlink recusado/);

  const nestedEnvironment = join(fixture, 'nested-environment');
  const state = join(nestedEnvironment, '.wrangler', 'state');
  mkdirSync(join(state, 'v3'), { recursive: true, mode: 0o700 });
  symlinkSync(join(fixture, 'missing-d1'), join(state, 'v3', 'd1'));
  const nested = invoke('status', '--persist-to', state);
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /Symlink recusado/);

  mkdirSync(join(fixture, 'legacy', '.wrangler', 'state'), {
    recursive: true,
    mode: 0o700,
  });
  const danglingEvidence = join(fixture, 'dangling-evidence');
  symlinkSync(join(fixture, 'missing-evidence'), danglingEvidence);
  const evidence = invoke(
    'legacy',
    '--persist-to',
    join(fixture, 'legacy', '.wrangler', 'state'),
    '--evidence-dir',
    danglingEvidence,
    '--through',
    '0002_link_test_mode',
  );
  assert.equal(evidence.status, 1);
  assert.match(evidence.stderr, /Symlink recusado/);
});
