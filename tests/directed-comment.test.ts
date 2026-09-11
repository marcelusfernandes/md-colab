import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commentDestination,
  directedCommentAttemptMatches,
  directedCommentContextFromResponse,
  visibleDirectedReplies,
} from '../lib/directed-comment.ts';

const rootId = '00000000-0000-4000-8000-000000000001';
const replyId = '00000000-0000-4000-8000-000000000002';
const comment = (id: string, root_id = rootId) => ({
  id,
  root_id,
  body: id === rootId ? 'Raiz' : 'Resposta',
  quote: id === rootId ? 'Trecho' : '',
  source_start: id === rootId ? 4 : null,
  created_at: '2026-09-11T00:00:00.000Z',
  author_id: 'author',
  author_name: 'Pessoa',
});

void test('destino aceita o contrato UUID local legado e rejeita valores de URL arbitrários', () => {
  assert.deepEqual(commentDestination(null), { id: null, error: '' });
  assert.equal(commentDestination(replyId).id, replyId);
  assert.equal(commentDestination('https://example.com').id, null);
  assert.match(commentDestination('../segredo').error, /inválido/);
});

void test('contexto valida alvo, raiz, estado e deduplica o alvo na apresentação', () => {
  const context = directedCommentContextFromResponse(
    {
      target: comment(replyId),
      conversation: {
        root: comment(rootId),
        replies: [comment(replyId)],
        repliesCursor: null,
        replyCount: 1,
        state: 'closed',
        decision: 'follow',
        decisionReason: 'Aplicar depois.',
        version: 2,
      },
    },
    replyId,
  );
  assert.equal(context.target.id, replyId);
  assert.deepEqual(visibleDirectedReplies(context), []);
  assert.throws(() =>
    directedCommentContextFromResponse(
      {
        ...context,
        conversation: {
          ...context.conversation,
          root: comment('00000000-0000-4000-8000-000000000099'),
        },
      },
      replyId,
    ),
  );
});

void test('resposta tardia só pertence à mesma sessão, documento, destino e sequência', () => {
  const attempt = {
    documentId: 'document-a',
    commentId: replyId,
    viewerId: 'viewer-a',
    request: 8,
  };
  assert.equal(
    directedCommentAttemptMatches(attempt, {
      documentId: 'document-a',
      commentId: replyId,
      viewerId: 'viewer-a',
      request: 8,
    }),
    true,
  );
  for (const current of [
    {
      documentId: 'document-b',
      commentId: replyId,
      viewerId: 'viewer-a',
      request: 8,
    },
    {
      documentId: 'document-a',
      commentId: rootId,
      viewerId: 'viewer-a',
      request: 8,
    },
    {
      documentId: 'document-a',
      commentId: replyId,
      viewerId: 'viewer-b',
      request: 8,
    },
    {
      documentId: 'document-a',
      commentId: replyId,
      viewerId: 'viewer-a',
      request: 9,
    },
  ])
    assert.equal(directedCommentAttemptMatches(attempt, current), false);
});
