import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createImportOperation,
  documentFromImportResponse,
  importAttemptMatches,
  importOperationMatchesSession,
  importOperationRequest,
  importSessionFromResponse,
} from '../lib/import-operation.ts';

function operation() {
  return createImportOperation({
    viewerId: 'viewer-a',
    isTest: true,
    filename: ' plano.md ',
    markdown: '\n# Plano\n\nConteúdo original.\n',
  });
}

void test('operação de importação congela UUID, autor e payload para todo reenvio', () => {
  const pending = operation();
  const first = importOperationRequest(pending);
  const second = importOperationRequest(pending);
  assert.match(pending.id, /^[0-9a-f-]{36}$/i);
  assert.equal(Object.isFrozen(pending), true);
  assert.deepEqual(second, first);
  assert.deepEqual(first, {
    id: pending.id,
    authorId: 'viewer-a',
    markdown: '\n# Plano\n\nConteúdo original.\n',
    filename: 'plano.md',
  });
});

void test('confirmação exige documento escalar com identidade, contexto e payload exatos', () => {
  const pending = operation();
  const document = {
    id: pending.id,
    owner_id: pending.viewerId,
    title: pending.title,
    filename: pending.filename,
    markdown: pending.markdown,
    is_test: 1,
    created_at: new Date().toISOString(),
  };
  assert.deepEqual(documentFromImportResponse({ document }, pending), document);
  for (const invalid of [
    null,
    [],
    {},
    { document: [] },
    { document: { ...document, id: [pending.id] } },
    { document: { ...document, owner_id: 'viewer-b' } },
    { document: { ...document, markdown: '# Outro' } },
    { document: { ...document, filename: 'outro.md' } },
    { document: { ...document, title: 'Outro' } },
    { document: { ...document, is_test: '1' } },
    { document: { ...document, created_at: null } },
    { document: { ...document, created_at: '' } },
    { document: { ...document, created_at: 'not-a-date' } },
  ])
    assert.throws(
      () => documentFromImportResponse(invalid, pending),
      /não confirmou esta importação/,
    );
});

void test('retomada exige sessão válida, mesmo autor, mesmo contexto e canCreate atual', () => {
  const pending = operation();
  const session = importSessionFromResponse({
    viewer: {
      id: 'viewer-a',
      email: 'a@example.com',
      name: 'A',
      isTest: true,
    },
    canCreate: true,
  });
  assert.equal(importOperationMatchesSession(pending, session), true);
  assert.equal(
    importOperationMatchesSession(pending, {
      ...session,
      viewer: { ...session.viewer, id: 'viewer-b' },
    }),
    false,
  );
  assert.equal(
    importOperationMatchesSession(pending, {
      ...session,
      viewer: { ...session.viewer, isTest: false },
    }),
    false,
  );
  assert.equal(
    importOperationMatchesSession(pending, { ...session, canCreate: false }),
    false,
  );
  for (const malformed of [
    null,
    [],
    { viewer: [], canCreate: true },
    { viewer: { id: ' viewer-a ', email: 'a@x', name: 'A' }, canCreate: true },
    { viewer: { id: ['viewer-a'], email: 'a@x', name: 'A' }, canCreate: true },
    { viewer: { id: 'viewer-a', email: 'a@x', name: 'A' }, canCreate: 'true' },
  ])
    assert.throws(
      () => importSessionFromResponse(malformed),
      /sessão.*inválida/,
    );
});

void test('resposta de tentativa antiga não corresponde ao pedido ou contexto atual', () => {
  const pending = operation();
  const attempt = { generation: 3, request: 7 };
  assert.equal(importAttemptMatches(pending, pending, attempt, 3, 7), true);
  assert.equal(importAttemptMatches(pending, pending, attempt, 4, 7), false);
  assert.equal(importAttemptMatches(pending, pending, attempt, 3, 8), false);
  assert.equal(
    importAttemptMatches(pending, operation(), attempt, 3, 7),
    false,
  );
  assert.equal(importAttemptMatches(pending, null, attempt, 3, 7), false);
});
