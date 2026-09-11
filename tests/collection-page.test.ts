import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  binaryTextCompare,
  collectionAttemptMatches,
  documentPageFromResponse,
  mergeDocumentPages,
  mergeSharePages,
  revokedEmailFromResponse,
  shareMutationFromResponse,
  sharePageFromResponse,
} from '../lib/collection-page.ts';
import type { DocumentSummary, ShareRow } from '../lib/document-service.ts';

function summary(id: string, createdAt: string): DocumentSummary {
  return {
    id,
    owner_id: 'owner',
    title: `Plano ${id}`,
    filename: `${id}.md`,
    is_test: 0,
    created_at: createdAt,
    owner_name: 'Dono',
    comment_count: 0,
  };
}

function share(email: string, createdAt: string): ShareRow {
  return { email, name: email, created_at: createdAt };
}

void test('valida o envelope inteiro antes de liberar itens ou continuação', () => {
  const validDocument = summary('document-a', '2026-09-10T12:00:00.000Z');
  assert.deepEqual(
    documentPageFromResponse({ documents: [validDocument], nextCursor: null }),
    { documents: [validDocument], nextCursor: null },
  );
  for (const value of [
    { documents: [validDocument] },
    {
      documents: [{ ...validDocument, markdown: '# privado' }],
      nextCursor: null,
    },
    {
      documents: [{ ...validDocument, created_at: 'data inválida' }],
      nextCursor: null,
    },
    { documents: [validDocument, validDocument], nextCursor: null },
    { documents: [validDocument], nextCursor: 'cursor_incompleto' },
  ])
    assert.throws(() => documentPageFromResponse(value));

  const validShare = share('person@example.com', '2026-09-10T12:00:00.000Z');
  assert.deepEqual(
    sharePageFromResponse({ shares: [validShare], nextCursor: null }),
    { shares: [validShare], nextCursor: null },
  );
  const fullSharePage = Array.from({ length: 100 }, (_, index) =>
    share(
      `person-${(100 - index).toString().padStart(3, '0')}@example.com`,
      '2026-09-10T12:00:00.000Z',
    ),
  );
  assert.equal(
    sharePageFromResponse({
      shares: fullSharePage,
      nextCursor: 'a'.repeat(3000),
    }).nextCursor?.length,
    3000,
  );
  for (const value of [
    { shares: [validShare] },
    { shares: [{ ...validShare, email: 'INVALID' }], nextCursor: null },
    { shares: [validShare, validShare], nextCursor: null },
    { shares: [validShare], nextCursor: '' },
    { shares: fullSharePage, nextCursor: 'a'.repeat(4097) },
  ])
    assert.throws(() => sharePageFromResponse(value));
});

void test('mescla importação intercalada e páginas históricas sem duplicar ou mover o cursor', () => {
  const first = Array.from({ length: 50 }, (_, index) =>
    summary(
      `document-${(100 - index).toString().padStart(3, '0')}`,
      '2026-09-10T12:00:00.000Z',
    ),
  );
  const imported = summary('document-new', '2026-09-10T13:00:00.000Z');
  const historical = Array.from({ length: 50 }, (_, index) =>
    summary(
      `document-${(50 - index).toString().padStart(3, '0')}`,
      '2026-09-10T12:00:00.000Z',
    ),
  );
  const cursor = 'cursor_historico';
  const afterImport = mergeDocumentPages(first, [imported]);
  const completed = mergeDocumentPages(afterImport, historical);
  assert.equal(cursor, 'cursor_historico');
  assert.equal(completed[0]?.id, imported.id);
  assert.equal(completed.length, 101);
  assert.equal(new Set(completed.map((entry) => entry.id)).size, 101);
});

void test('refresh corrente invalida página tardia e preserva cem cards e cursor da cauda', () => {
  const loaded = Array.from({ length: 100 }, (_, index) =>
    summary(
      `document-${(100 - index).toString().padStart(3, '0')}`,
      '2026-09-10T12:00:00.000Z',
    ),
  );
  const refreshedFirstPage = loaded.slice(0, 50).map((entry, index) =>
    index === 0
      ? { ...entry, title: 'Plano v3', filename: 'plano-v3.md', comment_count: 7 }
      : entry,
  );
  const pendingPage = { generation: 4, request: 7, context: 'owner:email' };
  const refresh = { generation: 4, request: 8, context: 'owner:email' };
  assert.equal(
    collectionAttemptMatches(pendingPage, 4, refresh.request, refresh.context),
    false,
  );
  assert.equal(
    collectionAttemptMatches(refresh, 4, refresh.request, refresh.context),
    true,
  );
  const merged = mergeDocumentPages(loaded, refreshedFirstPage);
  assert.equal(merged.length, 100);
  assert.equal(merged[0]?.title, 'Plano v3');
  assert.equal(merged[0]?.comment_count, 7);
});

void test('janela fresca sem o head anterior reinicia na página e cursor do servidor', () => {
  const loaded = [summary('document-old', '2026-09-10T12:00:00.000Z')];
  const fresh = Array.from({ length: 50 }, (_, index) =>
    summary(
      `document-new-${(50 - index).toString().padStart(3, '0')}`,
      '2026-09-11T12:00:00.000Z',
    ),
  );
  const hasContinuousWindow = fresh.some(
    (entry) => entry.id === loaded[0]?.id,
  );
  const visible = hasContinuousWindow
    ? mergeDocumentPages(loaded, fresh)
    : fresh;
  const cursor = hasContinuousWindow ? null : 'server-next-page';
  assert.equal(hasContinuousWindow, false);
  assert.deepEqual(visible, fresh);
  assert.equal(cursor, 'server-next-page');
});

void test('mutações alteram apenas o grant confirmado e preservam os demais carregados', () => {
  const old = share('old@example.com', '2026-09-10T11:00:00.000Z');
  const added = share('new@example.com', '2026-09-10T12:00:00.000Z');
  const result = shareMutationFromResponse({
    share: added,
    emailSubmitted: false,
    emailError: 'Transport indisponível.',
  });
  assert.deepEqual(mergeSharePages([old], [result.share]), [added, old]);
  assert.equal(
    revokedEmailFromResponse(
      { revokedEmail: 'new@example.com' },
      ' NEW@example.com ',
    ),
    'new@example.com',
  );
  assert.throws(() =>
    shareMutationFromResponse({ shares: [added], emailSubmitted: true }),
  );
  assert.throws(() =>
    revokedEmailFromResponse(
      { revokedEmail: 'old@example.com' },
      'new@example.com',
    ),
  );
});

void test('ordem binária e geração impedem resposta tardia de outro contexto', () => {
  assert.ok(binaryTextCompare('z@example.com', 'é@example.com') < 0);
  const attempt = { generation: 4, request: 7, context: 'document-a:owner' };
  assert.equal(collectionAttemptMatches(attempt, 4, 7, attempt.context), true);
  assert.equal(collectionAttemptMatches(attempt, 5, 7, attempt.context), false);
  assert.equal(collectionAttemptMatches(attempt, 4, 8, attempt.context), false);
  assert.equal(
    collectionAttemptMatches(attempt, 4, 7, 'document-b:owner'),
    false,
  );
});
