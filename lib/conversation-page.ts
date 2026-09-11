import type {
  ConversationEventRow,
  ConversationFilter,
  ConversationPage,
  ConversationRow,
} from './document-service.ts';
import { commentFromValue, mergeComments } from './comment-page.ts';

type MutableRef<T> = { current: T };

export function invalidateConversationLifecycle(
  generation: MutableRef<number>,
  pageRequest: MutableRef<number>,
  changeRequest: MutableRef<number>,
  changeInProgress: MutableRef<boolean>,
) {
  generation.current += 1;
  pageRequest.current += 1;
  changeRequest.current += 1;
  changeInProgress.current = false;
}

export function changeCursorAfterPoll(input: {
  initial: string;
  next: string;
  changed: boolean;
  reloaded: boolean;
}) {
  return input.changed && !input.reloaded ? input.initial : input.next;
}

export function conversationHistoryAttemptMatches(
  attempt: { documentId: string; rootId: string; request: number },
  documentId: string | null | undefined,
  request: number | undefined,
) {
  return attempt.documentId === documentId && attempt.request === request;
}

export function nextConversationHistoryRequest(
  sequence: MutableRef<number>,
  requests: Map<string, number>,
  rootId: string,
) {
  sequence.current += 1;
  requests.set(rootId, sequence.current);
  return sequence.current;
}

function cursor(value: unknown, nullable = false) {
  return (
    (nullable && value === null) ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 4096 &&
      /^[A-Za-z0-9_-]+$/.test(value))
  );
}

function nullableReason(value: unknown) {
  return value === null || (typeof value === 'string' && value.length <= 500);
}

export function conversationEventFromValue(value: unknown) {
  const event = value as Partial<ConversationEventRow> | null;
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.id !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(event.id) ||
    typeof event.root_id !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(event.root_id) ||
    typeof event.actor_id !== 'string' ||
    typeof event.actor_name !== 'string' ||
    !Number.isSafeInteger(event.base_version) ||
    event.base_version! < 0 ||
    event.version !== event.base_version! + 1 ||
    !['close', 'reopen', 'follow', 'refute', 'defer'].includes(event.action ?? '') ||
    !['open', 'closed'].includes(event.state ?? '') ||
    (event.decision !== null &&
      !['follow', 'refute', 'defer'].includes(event.decision ?? '')) ||
    !nullableReason(event.decision_reason) ||
    !nullableReason(event.reason) ||
    typeof event.created_at !== 'string' ||
    !Number.isFinite(Date.parse(event.created_at))
  )
    throw new Error('O servidor retornou um evento de conversa inválido.');
  return event as ConversationEventRow;
}

export function conversationPageFromResponse(value: unknown): ConversationPage {
  const result = value as Partial<ConversationPage> | null;
  if (
    !result ||
    !Array.isArray(result.conversations) ||
    result.conversations.length > 50 ||
    !cursor(result.nextCursor, true) ||
    !cursor(result.changeCursor)
  )
    throw new Error('O servidor retornou uma página de conversas inválida.');
  const ids = new Set<string>();
  const conversations = result.conversations.map((value) => {
    const entry = value as Partial<ConversationRow> | null;
    if (
      !entry ||
      typeof entry !== 'object' ||
      !Array.isArray(entry.replies) ||
      entry.replies.length > 3 ||
      !cursor(entry.repliesCursor, true) ||
      !Number.isSafeInteger(entry.replyCount) ||
      entry.replyCount! < entry.replies.length ||
      !['open', 'closed'].includes(entry.state ?? '') ||
      (entry.decision !== null &&
        !['follow', 'refute', 'defer'].includes(entry.decision ?? '')) ||
      !nullableReason(entry.decisionReason) ||
      !Number.isSafeInteger(entry.version) ||
      entry.version! < 0
    )
      throw new Error('O servidor retornou uma conversa inválida.');
    const root = commentFromValue(entry.root, ids);
    const replies = entry.replies.map((reply) => commentFromValue(reply, ids));
    if (
      root.root_id !== root.id ||
      replies.some((reply) => reply.root_id !== root.id)
    )
      throw new Error('O servidor retornou uma conversa inválida.');
    return { ...entry, root, replies } as ConversationRow;
  });
  return {
    conversations,
    nextCursor: result.nextCursor!,
    changeCursor: result.changeCursor!,
  };
}

export function conversationChangesFromResponse(value: unknown) {
  const result = value as {
    rootIds?: unknown;
    nextCursor?: unknown;
    hasMore?: unknown;
  } | null;
  if (
    !result ||
    !Array.isArray(result.rootIds) ||
    result.rootIds.length > 99 ||
    result.rootIds.some(
      (id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id),
    ) ||
    new Set(result.rootIds).size !== result.rootIds.length ||
    !cursor(result.nextCursor) ||
    typeof result.hasMore !== 'boolean'
  )
    throw new Error('O servidor retornou mudanças de conversas inválidas.');
  return result as {
    rootIds: string[];
    nextCursor: string;
    hasMore: boolean;
  };
}

export function conversationRepliesFromResponse(value: unknown, rootId: string) {
  const result = value as { replies?: unknown; nextCursor?: unknown } | null;
  if (
    !result ||
    !Array.isArray(result.replies) ||
    result.replies.length > 50 ||
    !cursor(result.nextCursor, true)
  )
    throw new Error('O servidor retornou respostas inválidas.');
  const replies = result.replies.map((reply) => commentFromValue(reply));
  if (
    new Set(replies.map((reply) => reply.id)).size !== replies.length ||
    replies.some((reply) => reply.root_id !== rootId)
  )
    throw new Error('O servidor retornou respostas inválidas.');
  return { replies, nextCursor: result.nextCursor as string | null };
}

export function conversationEventsFromResponse(value: unknown, rootId: string) {
  const result = value as { events?: unknown; nextCursor?: unknown } | null;
  if (
    !result ||
    !Array.isArray(result.events) ||
    result.events.length > 50 ||
    !cursor(result.nextCursor, true)
  )
    throw new Error('O servidor retornou um histórico inválido.');
  const events = result.events.map(conversationEventFromValue);
  if (
    new Set(events.map((event) => event.id)).size !== events.length ||
    events.some((event) => event.root_id !== rootId)
  )
    throw new Error('O servidor retornou um histórico inválido.');
  return { events, nextCursor: result.nextCursor as string | null };
}

export function mergeConversationReplies(
  conversation: ConversationRow,
  replies: ConversationRow['replies'],
  nextCursor: string | null,
) {
  return {
    ...conversation,
    replies: mergeComments(conversation.replies, replies),
    repliesCursor: nextCursor,
  };
}

export const conversationFilters: ReadonlyArray<{
  value: ConversationFilter;
  label: string;
}> = [
  { value: 'all', label: 'Todas' },
  { value: 'open', label: 'Abertas' },
  { value: 'unanswered', label: 'Sem resposta' },
  { value: 'closed', label: 'Encerradas' },
];
