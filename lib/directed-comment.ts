import type { CommentRow, DirectedCommentContext } from './document-service.ts';
import { commentFromValue } from './comment-page.ts';
import { conversationRepliesFromResponse } from './conversation-page.ts';

export const commentDestinationPattern = /^[0-9a-f-]{36}$/i;

export function commentDestination(value: string | null) {
  if (value === null) return { id: null, error: '' };
  if (!commentDestinationPattern.test(value))
    return {
      id: null,
      error: 'O link contém um identificador de comentário inválido.',
    };
  return { id: value, error: '' };
}

function nullableReason(value: unknown) {
  return value === null || (typeof value === 'string' && value.length <= 500);
}

export function directedCommentContextFromResponse(
  value: unknown,
  expectedTargetId: string,
): DirectedCommentContext {
  const result = value as Partial<DirectedCommentContext> | null;
  const conversation = result?.conversation;
  if (
    !result ||
    !conversation ||
    typeof conversation !== 'object' ||
    !Array.isArray(conversation.replies) ||
    conversation.replies.length > 50 ||
    (conversation.repliesCursor !== null &&
      (typeof conversation.repliesCursor !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(conversation.repliesCursor))) ||
    !Number.isSafeInteger(conversation.replyCount) ||
    conversation.replyCount! < conversation.replies.length ||
    !['open', 'closed'].includes(conversation.state ?? '') ||
    (conversation.decision !== null &&
      !['follow', 'refute', 'defer'].includes(conversation.decision ?? '')) ||
    !nullableReason(conversation.decisionReason) ||
    !Number.isSafeInteger(conversation.version) ||
    conversation.version! < 0
  )
    throw new Error('O servidor retornou um contexto de comentário inválido.');
  const target = commentFromValue(result.target);
  const root = commentFromValue(conversation.root);
  const replies = conversationRepliesFromResponse(
    {
      replies: conversation.replies,
      nextCursor: conversation.repliesCursor,
    },
    root.id,
  ).replies;
  if (
    target.id !== expectedTargetId ||
    root.root_id !== root.id ||
    target.root_id !== root.id ||
    replies.some((reply) => reply.id === root.id)
  )
    throw new Error('O servidor retornou um contexto de comentário inválido.');
  return {
    target,
    conversation: { ...conversation, root, replies },
  } as DirectedCommentContext;
}

export function directedCommentAttemptMatches(
  attempt: {
    documentId: string;
    commentId: string;
    viewerId: string;
    request: number;
  },
  current: {
    documentId: string | null | undefined;
    commentId: string | null;
    viewerId: string | null | undefined;
    request: number;
  },
) {
  return (
    attempt.documentId === current.documentId &&
    attempt.commentId === current.commentId &&
    attempt.viewerId === current.viewerId &&
    attempt.request === current.request
  );
}

export function visibleDirectedReplies(
  context: DirectedCommentContext,
): CommentRow[] {
  return context.conversation.replies.filter(
    (reply) => reply.id !== context.target.id,
  );
}
