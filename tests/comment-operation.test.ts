import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptOwnsRequest,
  commentFromResponse,
  createCommentOperation,
  operationAttemptMatches,
  operationMatchesContext,
  operationRequest,
  shouldClearComposer,
  updateCommentOperation,
} from '../lib/comment-operation.ts';

function operation() {
  return createCommentOperation({
    documentId: 'document-a',
    viewerId: 'viewer-a',
    body: '  Uma contribuição.  ',
    quote: '  trecho  ',
    sourceStart: 12,
    composerRevision: 4,
  });
}

void test('retry preserva a mesma identidade e o payload normalizado da tentativa', () => {
  const first = operation();
  const uncertain = updateCommentOperation(first, 'uncertain', 'Sem resposta.');
  const retry = updateCommentOperation(uncertain, 'sending', '');
  assert.deepEqual(operationRequest(retry), operationRequest(first));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(retry), true);
  assert.equal(operationRequest(retry).authorId, 'viewer-a');
});

void test('resposta confirma somente a operação e não consome uma revisão posterior do composer', () => {
  const pending = operation();
  const response = {
    comment: {
      id: pending.id,
      author_id: pending.viewerId,
      author_name: 'Pessoa',
      body: pending.body,
      quote: pending.quote,
      source_start: pending.sourceStart,
      created_at: '2026-09-10T12:00:00.000Z',
    },
  };
  assert.equal(commentFromResponse(response, pending).id, pending.id);
  assert.equal(shouldClearComposer(pending, 4), true);
  assert.equal(shouldClearComposer(pending, 5), false);
});

void test('documento, identidade e resposta divergentes não reconciliam a tentativa', () => {
  const pending = operation();
  assert.equal(
    operationMatchesContext(pending, pending.documentId, pending.viewerId),
    true,
  );
  assert.equal(
    operationMatchesContext(pending, 'document-b', pending.viewerId),
    false,
  );
  assert.equal(
    operationMatchesContext(pending, pending.documentId, 'viewer-b'),
    false,
  );
  assert.throws(
    () =>
      commentFromResponse(
        {
          comment: {
            id: pending.id,
            author_id: pending.viewerId,
            author_name: 'Pessoa',
            body: 'Outro conteúdo.',
            quote: pending.quote,
            source_start: pending.sourceStart,
            created_at: '2026-09-10T12:00:00.000Z',
          },
        },
        pending,
      ),
    /não confirmou este comentário/,
  );
});

void test('callback antigo não reaplica resposta após restauração ou nova tentativa', () => {
  const pending = operation();
  const firstAttempt = { generation: 7, request: 11 };
  assert.equal(
    operationAttemptMatches(
      pending,
      pending.documentId,
      pending.viewerId,
      firstAttempt,
      7,
      11,
    ),
    true,
  );
  assert.equal(
    operationAttemptMatches(
      pending,
      pending.documentId,
      pending.viewerId,
      firstAttempt,
      8,
      11,
    ),
    false,
    'os mesmos IDs não tornam atual uma resposta anterior à restauração',
  );
  assert.equal(attemptOwnsRequest(firstAttempt, 12), false);
  assert.equal(
    operationAttemptMatches(
      pending,
      pending.documentId,
      pending.viewerId,
      firstAttempt,
      7,
      12,
    ),
    false,
    'a tentativa anterior não libera nem altera o retry mais novo',
  );
});
