import type { CommentRow } from './document-service.ts';

export type CommentOperationStatus =
  | 'sending'
  | 'uncertain'
  | 'error'
  | 'blocked';

export type CommentOperation = Readonly<{
  id: string;
  documentId: string;
  viewerId: string;
  body: string;
  quote: string;
  sourceStart: number | null;
  sourceRevisionId: string;
  rootId: string | null;
  composerRevision: number;
  status: CommentOperationStatus;
  message: string;
}>;

export type CommentAttempt = Readonly<{
  generation: number;
  request: number;
}>;

export function preserveDraftSourceRevision(
  capturedRevisionId: string | null,
  displayedRevisionId: string,
) {
  return capturedRevisionId ?? displayedRevisionId;
}

export function createCommentOperation(input: {
  documentId: string;
  viewerId: string;
  body: string;
  quote: string;
  sourceStart: number | null;
  sourceRevisionId: string;
  rootId?: string | null;
  composerRevision: number;
}): CommentOperation {
  return Object.freeze({
    id: crypto.randomUUID(),
    documentId: input.documentId,
    viewerId: input.viewerId,
    body: input.body.trim(),
    quote: input.quote.trim(),
    sourceStart: input.sourceStart,
    sourceRevisionId: input.sourceRevisionId,
    rootId: input.rootId ?? null,
    composerRevision: input.composerRevision,
    status: 'sending' as const,
    message: '',
  });
}

export function updateCommentOperation(
  operation: CommentOperation,
  status: CommentOperationStatus,
  message: string,
): CommentOperation {
  return Object.freeze({ ...operation, status, message });
}

export function operationMatchesContext(
  operation: CommentOperation,
  documentId: string | null | undefined,
  viewerId: string | null | undefined,
) {
  return operation.documentId === documentId && operation.viewerId === viewerId;
}

export function operationAttemptMatches(
  operation: CommentOperation,
  documentId: string | null | undefined,
  viewerId: string | null | undefined,
  attempt: CommentAttempt,
  currentGeneration: number,
  currentRequest: number,
) {
  return (
    operationMatchesContext(operation, documentId, viewerId) &&
    attempt.generation === currentGeneration &&
    attempt.request === currentRequest
  );
}

export function attemptOwnsRequest(
  attempt: CommentAttempt,
  currentRequest: number,
) {
  return attempt.request === currentRequest;
}

export function shouldClearComposer(
  operation: CommentOperation,
  currentComposerRevision: number,
) {
  return operation.composerRevision === currentComposerRevision;
}

export function operationRequest(operation: CommentOperation) {
  return {
    id: operation.id,
    authorId: operation.viewerId,
    body: operation.body,
    quote: operation.quote,
    sourceStart: operation.sourceStart,
    sourceRevisionId: operation.sourceRevisionId,
    ...(operation.rootId === null ? {} : { rootId: operation.rootId }),
  };
}

export function commentFromResponse(
  value: unknown,
  operation: CommentOperation,
): CommentRow {
  const result = value as { comment?: Partial<CommentRow> } | null;
  const comment = result?.comment;
  if (
    !comment ||
    comment.id !== operation.id ||
    comment.author_id !== operation.viewerId ||
    comment.body !== operation.body ||
    comment.quote !== operation.quote ||
    comment.source_start !== operation.sourceStart ||
    comment.source_revision_id !== operation.sourceRevisionId ||
    comment.root_id !== (operation.rootId ?? operation.id) ||
    typeof comment.created_at !== 'string' ||
    typeof comment.author_name !== 'string'
  )
    throw new Error(
      'A resposta não confirmou este comentário. Verifique antes de reenviar.',
    );
  return comment as CommentRow;
}
