import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  documentDestination,
  mergeRevisionPages,
  refreshedRevisionPage,
  revisionPageFromResponse,
  revisionReadMatches,
} from '../lib/revision-history.ts';
import type { DocumentRevisionSummary } from '../lib/document-service.ts';

const documentId = '00000000-0000-4000-8000-000000000001';
function summary(ordinal: number): DocumentRevisionSummary {
  return {
    id: `00000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`,
    document_id: documentId,
    ordinal,
    author_id: 'owner',
    author_name: 'Dona',
    title: `Revisão ${ordinal}`,
    filename: `revisao-${ordinal}.md`,
    base_revision_id:
      ordinal === 1
        ? null
        : `00000000-0000-4000-8000-${(ordinal - 1).toString().padStart(12, '0')}`,
    summary: ordinal === 1 ? null : `Resumo ${ordinal}`,
    created_at: `2026-09-11T${String(ordinal % 24).padStart(2, '0')}:00:00.000Z`,
  };
}

void test('página valida envelope, ordem, plano e ausência de Markdown', () => {
  const revisions = [summary(3), summary(2), summary(1)];
  assert.deepEqual(
    revisionPageFromResponse({ revisions, nextCursor: null }, documentId),
    { revisions, nextCursor: null },
  );
  for (const value of [
    { revisions },
    { revisions: [summary(2), summary(3)], nextCursor: null },
    {
      revisions: [{ ...summary(3), document_id: crypto.randomUUID() }],
      nextCursor: null,
    },
    {
      revisions: [{ ...summary(3), markdown: '# privado' }],
      nextCursor: null,
    },
    { revisions, nextCursor: 'cursor' },
  ])
    assert.throws(() => revisionPageFromResponse(value, documentId));
});

void test('refresh mescla por ID e tentativa exige seleção e contexto atuais', () => {
  const current = [summary(3), summary(2), summary(1)];
  const incoming = [summary(4), { ...summary(3), title: 'Título corrigido' }];
  const merged = mergeRevisionPages(current, incoming);
  assert.deepEqual(
    merged.map((revision) => revision.ordinal),
    [4, 3, 2, 1],
  );
  assert.equal(merged[1]?.title, 'Título corrigido');
  const attempt = {
    request: 4,
    context: 'doc:viewer',
    revisionId: summary(2).id,
  };
  assert.equal(
    revisionReadMatches(attempt, 4, 'doc:viewer', summary(2).id),
    true,
  );
  assert.equal(
    revisionReadMatches(attempt, 5, 'doc:viewer', summary(2).id),
    false,
  );
  assert.equal(
    revisionReadMatches(attempt, 4, 'doc:other', summary(2).id),
    false,
  );
  assert.equal(
    revisionReadMatches(attempt, 4, 'doc:viewer', summary(3).id),
    false,
  );
});

void test('refresh preserva cursor só com continuidade comprovada e reinicia 55 novidades', () => {
  const current = [summary(3), summary(2), summary(1)];
  const overlap = refreshedRevisionPage(
    current,
    'cursor-antigo',
    [summary(4), summary(3)],
    'cursor-novo',
  );
  assert.deepEqual(
    overlap.revisions.map((entry) => entry.ordinal),
    [4, 3, 2, 1],
  );
  assert.equal(overlap.nextCursor, 'cursor-antigo');
  assert.equal(overlap.reset, false);

  const firstOfFiftyFive = Array.from({ length: 50 }, (_, index) =>
    summary(58 - index),
  );
  const disjoint = refreshedRevisionPage(
    current,
    null,
    firstOfFiftyFive,
    'restam-cinco',
  );
  assert.equal(disjoint.reset, true);
  assert.equal(disjoint.revisions.length, 50);
  assert.equal(disjoint.nextCursor, 'restam-cinco');
  assert.equal(
    disjoint.revisions.some((entry) => entry.id === current[0]!.id),
    false,
  );
});

void test('URL mantém extras legados e rejeita destinos repetidos ou misturados', () => {
  const comment = crypto.randomUUID();
  const revision = crypto.randomUUID();
  assert.deepEqual(
    documentDestination(new URLSearchParams({ revision, legacy: '1' })),
    {
      commentId: null,
      revisionId: revision,
      error: '',
    },
  );
  assert.match(
    documentDestination(
      new URLSearchParams(`comment=${comment}&revision=${revision}`),
    ).error,
    /mistura/,
  );
  assert.match(
    documentDestination(
      new URLSearchParams(`revision=${revision}&revision=${revision}`),
    ).error,
    /repete/,
  );
  assert.match(
    documentDestination(new URLSearchParams('revision=../fora')).error,
    /inválida/,
  );
});
