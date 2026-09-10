import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiTimeoutError } from '../lib/client-api.ts';
import {
  commentFromResponse,
  createCommentOperation,
} from '../lib/comment-operation.ts';

void test('timeout inclui a espera pelo corpo da resposta', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"comment":'));
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('null}'));
            controller.close();
          }, 80);
        },
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  await assert.rejects(
    api('documents/id/comments', 'POST', {}, { timeoutMs: 10 }),
    ApiTimeoutError,
  );
});

void test('corpo 2xx ausente não é aceito como confirmação de comentário', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => new Response('', { status: 201 });
  const pending = createCommentOperation({
    documentId: 'document-a',
    viewerId: 'viewer-a',
    body: 'Contribuição',
    quote: '',
    sourceStart: null,
    composerRevision: 0,
  });
  const response = await api<unknown>(
    'documents/document-a/comments',
    'POST',
    {},
    { timeoutMs: 100 },
  );
  assert.throws(
    () => commentFromResponse(response, pending),
    /não confirmou este comentário/,
  );
});
