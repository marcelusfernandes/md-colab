import type { CommentRow, DirectedCommentContext } from './document-service.ts';
import { commentFromValue, mergeComments } from './comment-page.ts';
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

export function mergeDirectedConfirmedComment(
  context: DirectedCommentContext,
  confirmed: CommentRow,
): DirectedCommentContext {
  if (context.conversation.root.id !== confirmed.root_id) return context;
  const isRoot = confirmed.id === context.conversation.root.id;
  const isTarget = context.target.id === confirmed.id;
  const isLoadedReply = context.conversation.replies.some(
    (reply) => reply.id === confirmed.id,
  );
  const alreadyPresent =
    isRoot || isTarget || isLoadedReply;
  return {
    target: context.target.id === confirmed.id ? confirmed : context.target,
    conversation: {
      ...context.conversation,
      root: isRoot ? confirmed : context.conversation.root,
      replies: isRoot || (isTarget && !isLoadedReply)
        ? context.conversation.replies
        : mergeComments(context.conversation.replies, [confirmed]),
      replyCount: alreadyPresent
        ? context.conversation.replyCount
        : context.conversation.replyCount + 1,
    },
  };
}

export function reconcileDirectedCommentContext(
  current: DirectedCommentContext | null,
  fresh: DirectedCommentContext,
  previousRecentReplyIds: readonly string[] | null,
) {
  if (
    !current ||
    !previousRecentReplyIds ||
    current.target.id !== fresh.target.id ||
    current.conversation.root.id !== fresh.conversation.root.id
  )
    return { context: fresh, reset: false };
  const freshIds = new Set(
    fresh.conversation.replies.map((reply) => reply.id),
  );
  const hasAuthoritativeOverlap = previousRecentReplyIds.some((id) =>
    freshIds.has(id),
  );
  if (!hasAuthoritativeOverlap)
    return {
      context: fresh,
      reset: current.conversation.replies.some(
        (reply) => !freshIds.has(reply.id),
      ),
    };
  return {
    context: {
      ...fresh,
      conversation: {
        ...fresh.conversation,
        replies: mergeComments(
          current.conversation.replies,
          fresh.conversation.replies,
        ),
        repliesCursor: current.conversation.repliesCursor,
      },
    },
    reset: false,
  };
}
