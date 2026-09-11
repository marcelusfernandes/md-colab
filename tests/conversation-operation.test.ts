import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conversationEventFromResponse,
  conversationOperationMatches,
  conversationOperationRequest,
  createConversationDraft,
  createConversationOperation,
  updateConversationOperation,
} from '../lib/conversation-operation.ts';
import type { ConversationRow } from '../lib/document-service.ts';

void test('operação congela raiz, ação, motivo e versão para replay consciente', () => {
  const operation = createConversationOperation({
    documentId: 'document-a',
    rootId: '00000000-0000-4000-8000-000000000001',
    viewerId: 'owner-a',
    baseVersion: 4,
    action: 'refute',
    reason: '  A premissa não se confirmou.  ',
  });
  const uncertain = updateConversationOperation(
    operation,
    'uncertain',
    'Sem resposta.',
  );
  assert.equal(Object.isFrozen(operation), true);
  assert.equal(Object.isFrozen(uncertain), true);
  assert.deepEqual(
    conversationOperationRequest(uncertain),
    conversationOperationRequest(operation),
  );
  assert.equal(conversationOperationRequest(operation).reason, 'A premissa não se confirmou.');
  assert.equal(conversationOperationMatches(operation, 'document-a', 'owner-a'), true);
  assert.equal(conversationOperationMatches(operation, 'document-b', 'owner-a'), false);
});

void test('confirmação exige UUID, raiz, ator, versão, ação e motivo exatos', () => {
  const operation = createConversationOperation({
    documentId: 'document-a',
    rootId: '00000000-0000-4000-8000-000000000001',
    viewerId: 'owner-a',
    baseVersion: 0,
    action: 'follow',
    reason: 'Faz sentido.',
  });
  const event = {
    id: operation.id,
    root_id: operation.rootId,
    actor_id: operation.viewerId,
    actor_name: 'Autor',
    base_version: 0,
    version: 1,
    action: 'follow',
    state: 'open',
    decision: 'follow',
    decision_reason: 'Faz sentido.',
    reason: 'Faz sentido.',
    created_at: '2026-09-10T12:00:00.000Z',
  };
  assert.deepEqual(conversationEventFromResponse({ event }, operation), event);
  assert.throws(
    () => conversationEventFromResponse({ event: { ...event, reason: 'Outro' } }, operation),
    /não confirmou/,
  );
});

void test('rascunho mantém a versão vista quando o cartão recebe estado mais novo', () => {
  const conversation = {
    decision: null,
    decisionReason: null,
    version: 0,
  } as ConversationRow;
  const draft = createConversationDraft(conversation);
  const refreshed = { ...conversation, decision: 'refute', version: 1 } as ConversationRow;
  assert.equal(createConversationDraft(refreshed).baseVersion, 1);
  assert.equal(draft.baseVersion, 0);
  assert.equal(Object.isFrozen(draft), true);
});
