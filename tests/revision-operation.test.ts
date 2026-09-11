import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRevisionOperation,
  documentFromInitialRevisionResponse,
  revisionAttemptMatches,
  revisionFromOperationResponse,
  revisionFromResponse,
  revisionDraftMatchesOperation,
  revisionOperationMatchesAccess,
  revisionOperationMatchesContext,
  revisionOperationMatchesIdentity,
  revisionOperationRequest,
  revisionOperationWithBase,
} from '../lib/revision-operation.ts';
import { createImportOperation } from '../lib/import-operation.ts';
import type { DocumentRevisionReceipt, DocumentRow, Viewer } from '../lib/document-service.ts';

const viewer: Viewer = {
  id: 'revision-viewer',
  email: 'author@example.com',
  name: 'Autora',
};

function document(overrides: Partial<DocumentRow> = {}): DocumentRow {
  const id = crypto.randomUUID();
  return {
    id,
    owner_id: viewer.id,
    title: 'Plano',
    filename: 'plano.md',
    markdown: '# Plano',
    current_revision_id: id,
    revision_ordinal: 1,
    revision_author_id: viewer.id,
    revision_created_at: '2026-09-11T10:00:00.000Z',
    is_test: 0,
    created_at: '2026-09-11T10:00:00.000Z',
    ...overrides,
  };
}

function receipt(
  operation: ReturnType<typeof createRevisionOperation>,
): DocumentRevisionReceipt {
  const commentIds = operation.consideredCommentIds;
  return {
    id: operation.id,
    document_id: operation.documentId,
    ordinal: operation.baseOrdinal + 1,
    author_id: operation.viewerId,
    title: operation.title,
    filename: operation.filename,
    markdown: operation.markdown,
    base_revision_id: operation.baseRevisionId,
    summary: operation.summary || null,
    considered_comment_ids: commentIds,
    considered_comments: commentIds.map((id) => ({
      id,
      root_id: id,
      source_revision_id: operation.baseRevisionId,
      author_id: 'comment-author',
      author_name: 'Pessoa',
      body: 'Crítica',
      quote: '',
      created_at: '2026-09-11T10:01:00.000Z',
    })),
    created_at: '2026-09-11T10:02:00.000Z',
  };
}

void test('tentativa congela payload e atualizar base cria UUID sem enviar ou perder seleção', () => {
  const source = document();
  const commentA = '018f47a2-7b3c-7abc-8def-1234567890ab';
  const commentB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const operation = createRevisionOperation({
    document: source,
    viewer,
    filename: ' revisão.md ',
    markdown: '# Revisão\r\n\r\nConteúdo.\r\n',
    summary: '  Síntese  ',
    consideredCommentIds: [commentB, commentA, commentB],
  });
  assert.equal(Object.isFrozen(operation), true);
  assert.deepEqual(operation.consideredCommentIds, [commentA, commentB]);
  assert.deepEqual(revisionOperationRequest(operation), {
    id: operation.id,
    baseRevisionId: source.current_revision_id,
    markdown: '# Revisão\r\n\r\nConteúdo.\r\n',
    filename: 'revisão.md',
    summary: 'Síntese',
    consideredCommentIds: [commentA, commentB],
  });
  const current = document({
    id: source.id,
    current_revision_id: crypto.randomUUID(),
    revision_ordinal: 3,
  });
  const rebased = revisionOperationWithBase(operation, current);
  assert.notEqual(rebased.id, operation.id);
  assert.equal(rebased.baseRevisionId, current.current_revision_id);
  assert.equal(rebased.baseOrdinal, 3);
  assert.equal(rebased.markdown, operation.markdown);
  assert.equal(rebased.summary, operation.summary);
  assert.deepEqual(rebased.consideredCommentIds, operation.consideredCommentIds);
  assert.equal(
    revisionDraftMatchesOperation(operation, '  Síntese ', [commentB, commentA]),
    true,
  );
  assert.equal(
    revisionDraftMatchesOperation(operation, 'Resumo B', [commentA]),
    false,
  );
});

void test('recibo aceita comentário legado e confirma todos os campos imutáveis', () => {
  const operation = createRevisionOperation({
    document: document(),
    viewer,
    filename: 'revisao.md',
    markdown: '# Revisão',
    summary: 'Síntese',
    consideredCommentIds: ['018f47a2-7b3c-7abc-8def-1234567890ab'],
  });
  const value = { revision: receipt(operation) };
  assert.deepEqual(revisionFromResponse(value), value.revision);
  assert.deepEqual(revisionFromOperationResponse(value, operation), value.revision);
  for (const changed of [
    { markdown: '# Diferente' },
    { summary: 'Outro' },
    { base_revision_id: crypto.randomUUID() },
    { considered_comment_ids: [] },
  ])
    assert.throws(
      () =>
        revisionFromOperationResponse(
          { revision: { ...value.revision, ...changed } },
          operation,
        ),
      /não confirmou esta revisão|revisão inválida/,
    );
});

void test('retomada e respostas tardias exigem o mesmo plano, autor e pedido', () => {
  const source = document();
  const operation = createRevisionOperation({
    document: source,
    viewer,
    filename: 'revisao.md',
    markdown: '# Revisão',
    summary: '',
    consideredCommentIds: [],
  });
  assert.equal(
    revisionOperationMatchesContext(operation, source.id, viewer, true),
    true,
  );
  assert.equal(
    revisionOperationMatchesContext(operation, source.id, viewer, false),
    false,
  );
  assert.equal(revisionOperationMatchesAccess(operation, source.id, viewer), true);
  assert.equal(
    revisionOperationMatchesIdentity(operation, { ...viewer, id: 'viewer-b' }),
    false,
  );
  assert.equal(
    revisionOperationMatchesIdentity(operation, { ...viewer, isTest: true }),
    false,
  );
  assert.equal(
    revisionOperationMatchesContext(operation, crypto.randomUUID(), viewer, true),
    false,
  );
  const attempt = { generation: 2, request: 4 };
  assert.equal(revisionAttemptMatches(operation, operation, attempt, 2, 4), true);
  assert.equal(revisionAttemptMatches(operation, operation, attempt, 3, 4), false);
  assert.equal(revisionAttemptMatches(operation, operation, attempt, 2, 5), false);
  assert.equal(revisionAttemptMatches(operation, null, attempt, 2, 4), false);
});

void test('recibo v1 recupera a importação inicial sem projetar uma revisão posterior', () => {
  const operation = createImportOperation({
    viewerId: viewer.id,
    isTest: false,
    filename: 'plano.md',
    markdown: '# Plano inicial',
  });
  const initial = {
    id: operation.id,
    document_id: operation.id,
    ordinal: 1,
    author_id: operation.viewerId,
    title: operation.title,
    filename: operation.filename,
    markdown: operation.markdown,
    base_revision_id: null,
    summary: null,
    considered_comment_ids: [],
    considered_comments: [],
    created_at: '2026-09-11T10:00:00.000Z',
  };
  const recovered = documentFromInitialRevisionResponse(
    { revision: initial },
    operation,
  );
  assert.equal(recovered.current_revision_id, operation.id);
  assert.equal(recovered.revision_ordinal, 1);
  assert.equal(recovered.markdown, operation.markdown);
  assert.throws(
    () =>
      documentFromInitialRevisionResponse(
        { revision: { ...initial, ordinal: 2 } },
        operation,
      ),
    /não confirmou esta importação/,
  );
});
