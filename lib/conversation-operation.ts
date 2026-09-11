import type {
  ConversationEventAction,
  ConversationEventRow,
} from './document-service.ts';
import { conversationEventFromValue } from './conversation-page.ts';

export type ConversationOperationStatus = 'sending' | 'uncertain' | 'error';
export type ConversationOperation = Readonly<{
  id: string;
  documentId: string;
  rootId: string;
  viewerId: string;
  baseVersion: number;
  action: ConversationEventAction;
  reason: string | null;
  status: ConversationOperationStatus;
  message: string;
}>;

export function createConversationOperation(input: {
  documentId: string;
  rootId: string;
  viewerId: string;
  baseVersion: number;
  action: ConversationEventAction;
  reason?: string | null;
}) {
  return Object.freeze({
    ...input,
    id: crypto.randomUUID(),
    reason: input.reason?.trim() || null,
    status: 'sending' as const,
    message: '',
  });
}

export function updateConversationOperation(
  operation: ConversationOperation,
  status: ConversationOperationStatus,
  message: string,
) {
  return Object.freeze({ ...operation, status, message });
}

export function conversationOperationRequest(operation: ConversationOperation) {
  return {
    id: operation.id,
    authorId: operation.viewerId,
    baseVersion: operation.baseVersion,
    action: operation.action,
    ...(operation.reason === null ? {} : { reason: operation.reason }),
  };
}

export function conversationOperationMatches(
  operation: ConversationOperation,
  documentId: string | null | undefined,
  viewerId: string | null | undefined,
) {
  return operation.documentId === documentId && operation.viewerId === viewerId;
}

export function conversationEventFromResponse(
  value: unknown,
  operation: ConversationOperation,
) {
  const result = value as { event?: unknown } | null;
  const event = conversationEventFromValue(result?.event);
  if (
    event.id !== operation.id ||
    event.root_id !== operation.rootId ||
    event.actor_id !== operation.viewerId ||
    event.base_version !== operation.baseVersion ||
    event.action !== operation.action ||
    event.reason !== operation.reason
  )
    throw new Error('A resposta não confirmou esta alteração de conversa.');
  return event as ConversationEventRow;
}
