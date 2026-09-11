import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conversationChangesFromResponse,
  conversationPageFromResponse,
  conversationRepliesFromResponse,
} from '../lib/conversation-page.ts';

const root = {
  id: '00000000-0000-4000-8000-000000000001',
  root_id: '00000000-0000-4000-8000-000000000001',
  body: 'Crítica',
  quote: '',
  source_start: null,
  created_at: '2026-09-10T12:00:00.000Z',
  author_id: 'guest',
  author_name: 'Revisor',
};
const cursor = 'eyJ2IjoxfQ';

void test('página valida coleção limitada, estado e filtro sem aceitar conversa parcial', () => {
  const page = conversationPageFromResponse({
    conversations: [
      {
        root,
        replies: [],
        repliesCursor: null,
        replyCount: 0,
        state: 'open',
        decision: null,
        decisionReason: null,
        version: 0,
      },
    ],
    nextCursor: null,
    changeCursor: cursor,
  });
  assert.equal(page.conversations[0]?.root.id, root.id);
  assert.throws(() =>
    conversationPageFromResponse({
      ...page,
      conversations: [{ ...page.conversations[0], replyCount: 0, replies: [{ ...root, id: '00000000-0000-4000-8000-000000000002', root_id: root.id }] }],
    }),
  );
});

void test('feed rejeita cursor e UUID inválidos antes de avançar watermark', () => {
  const valid = conversationChangesFromResponse({
    rootIds: [root.id],
    nextCursor: cursor,
    hasMore: false,
  });
  assert.deepEqual(valid.rootIds, [root.id]);
  assert.throws(() =>
    conversationChangesFromResponse({
      rootIds: [root.id, root.id],
      nextCursor: cursor,
      hasMore: false,
    }),
  );
});

void test('respostas paginadas permanecem vinculadas à raiz pedida', () => {
  const reply = {
    ...root,
    id: '00000000-0000-4000-8000-000000000002',
    root_id: root.id,
  };
  assert.deepEqual(
    conversationRepliesFromResponse({ replies: [reply], nextCursor: null }, root.id)
      .replies,
    [reply],
  );
  assert.throws(() =>
    conversationRepliesFromResponse(
      { replies: [{ ...reply, root_id: reply.id }], nextCursor: null },
      root.id,
    ),
  );
});
