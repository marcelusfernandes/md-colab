import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changeCursorAfterPoll,
  conversationChangesFromResponse,
  conversationHistoryAttemptMatches,
  conversationPageFromResponse,
  conversationRepliesFromResponse,
  invalidateConversationLifecycle,
  mergeConversationEventState,
  nextConversationHistoryRequest,
} from '../lib/conversation-page.ts';
import type { ConversationEventRow, ConversationRow } from '../lib/document-service.ts';

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

void test('invalidação libera o poll e respostas tardias não assumem o novo contexto', () => {
  const generation = { current: 3 };
  const pageRequest = { current: 7 };
  const changeRequest = { current: 11 };
  const inProgress = { current: true };
  invalidateConversationLifecycle(
    generation,
    pageRequest,
    changeRequest,
    inProgress,
  );
  assert.deepEqual(
    [generation.current, pageRequest.current, changeRequest.current, inProgress.current],
    [4, 8, 12, false],
  );
  const historyAttempt = { documentId: 'document-a', rootId: root.id, request: 2 };
  assert.equal(
    conversationHistoryAttemptMatches(historyAttempt, 'document-a', 3),
    false,
  );
  assert.equal(
    conversationHistoryAttemptMatches(historyAttempt, 'document-b', 2),
    false,
  );
});

void test('poll só consome mudança depois de recarregar o estado observado', () => {
  assert.equal(
    changeCursorAfterPoll({
      initial: 'cursor-antigo',
      next: 'cursor-novo',
      changed: true,
      reloaded: false,
    }),
    'cursor-antigo',
  );
  assert.equal(
    changeCursorAfterPoll({
      initial: 'cursor-antigo',
      next: 'cursor-novo',
      changed: false,
      reloaded: false,
    }),
    'cursor-novo',
  );
});

void test('histórico não reutiliza identidade de request depois de limpar o contexto', () => {
  const sequence = { current: 0 };
  const requests = new Map<string, number>();
  const first = nextConversationHistoryRequest(sequence, requests, root.id);
  requests.clear();
  const second = nextConversationHistoryRequest(sequence, requests, root.id);
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(
    conversationHistoryAttemptMatches(
      { documentId: 'document-a', rootId: root.id, request: first },
      'document-a',
      requests.get(root.id),
    ),
    false,
  );
});

void test('lookup de evento antigo não regride estado canônico mais novo', () => {
  const conversation = {
    root,
    state: 'open',
    decision: 'defer',
    decisionReason: 'Estado mais novo.',
    version: 2,
  } as ConversationRow;
  const oldEvent = {
    root_id: root.id,
    state: 'closed',
    decision: 'follow',
    decision_reason: 'Estado antigo.',
    version: 1,
  } as ConversationEventRow;
  assert.equal(mergeConversationEventState(conversation, oldEvent), conversation);
  assert.equal(
    mergeConversationEventState(conversation, {
      ...oldEvent,
      version: 3,
      state: 'closed',
    }).version,
    3,
  );
});
