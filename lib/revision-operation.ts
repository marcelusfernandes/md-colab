import type {
  ConsideredCommentRow,
  DocumentRevisionReceipt,
  DocumentRow,
  Viewer,
} from './document-service.ts';
import { inferredDocumentTitle, type ImportOperation } from './import-operation.ts';

export type RevisionOperationStatus =
  | 'sending'
  | 'uncertain'
  | 'conflict'
  | 'error'
  | 'blocked';

export type RevisionOperation = Readonly<{
  id: string;
  documentId: string;
  viewerId: string;
  isTest: boolean;
  baseRevisionId: string;
  baseOrdinal: number;
  filename: string;
  markdown: string;
  title: string;
  summary: string;
  consideredCommentIds: string[];
  status: RevisionOperationStatus;
  message: string;
}>;

export type RevisionAttempt = Readonly<{
  generation: number;
  request: number;
}>;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const legacyCommentIdPattern = /^[0-9a-f-]{36}$/i;
const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function exactKeys(value: object, expected: string[]) {
  return (
    Object.keys(value).sort(compareText).join(',') ===
    [...expected].sort(compareText).join(',')
  );
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function createRevisionOperation(input: {
  document: DocumentRow;
  viewer: Viewer;
  filename: string;
  markdown: string;
  summary: string;
  consideredCommentIds: readonly string[];
}): RevisionOperation {
  const filename = input.filename.trim();
  return Object.freeze({
    id: crypto.randomUUID(),
    documentId: input.document.id,
    viewerId: input.viewer.id,
    isTest: Boolean(input.viewer.isTest),
    baseRevisionId: input.document.current_revision_id,
    baseOrdinal: input.document.revision_ordinal,
    filename,
    markdown: input.markdown,
    title: inferredDocumentTitle(input.markdown, filename),
    summary: input.summary.trim(),
    consideredCommentIds: [...new Set(input.consideredCommentIds)].sort(
      compareText,
    ),
    status: 'sending',
    message: '',
  });
}

export function updateRevisionOperation(
  operation: RevisionOperation,
  status: RevisionOperationStatus,
  message: string,
): RevisionOperation {
  return Object.freeze({ ...operation, status, message });
}

export function revisionOperationWithBase(
  operation: RevisionOperation,
  document: DocumentRow,
): RevisionOperation {
  return Object.freeze({
    ...operation,
    id: crypto.randomUUID(),
    baseRevisionId: document.current_revision_id,
    baseOrdinal: document.revision_ordinal,
    status: 'sending' as const,
    message: '',
  });
}

export function revisionOperationRequest(operation: RevisionOperation) {
  return {
    id: operation.id,
    baseRevisionId: operation.baseRevisionId,
    markdown: operation.markdown,
    filename: operation.filename,
    summary: operation.summary || null,
    consideredCommentIds: operation.consideredCommentIds,
  };
}

export function revisionOperationMatchesContext(
  operation: RevisionOperation,
  documentId: string | null | undefined,
  viewer: Viewer | null | undefined,
  canCreate: boolean,
) {
  return (
    canCreate && revisionOperationMatchesAccess(operation, documentId, viewer)
  );
}

export function revisionOperationMatchesAccess(
  operation: RevisionOperation,
  documentId: string | null | undefined,
  viewer: Viewer | null | undefined,
) {
  return (
    operation.documentId === documentId &&
    operation.viewerId === viewer?.id &&
    operation.isTest === Boolean(viewer?.isTest)
  );
}

export function revisionAttemptMatches(
  operation: RevisionOperation,
  current: RevisionOperation | null,
  attempt: RevisionAttempt,
  generation: number,
  request: number,
) {
  return (
    current?.id === operation.id &&
    attempt.generation === generation &&
    attempt.request === request
  );
}

function consideredComment(value: unknown): ConsideredCommentRow {
  const comment = value as Partial<ConsideredCommentRow> | null;
  if (
    !comment ||
    typeof comment !== 'object' ||
    Array.isArray(comment) ||
    !exactKeys(comment, [
      'id',
      'root_id',
      'source_revision_id',
      'author_id',
      'author_name',
      'body',
      'quote',
      'created_at',
    ]) ||
    typeof comment.id !== 'string' ||
    !legacyCommentIdPattern.test(comment.id) ||
    typeof comment.root_id !== 'string' ||
    !legacyCommentIdPattern.test(comment.root_id) ||
    typeof comment.source_revision_id !== 'string' ||
    !uuidPattern.test(comment.source_revision_id) ||
    typeof comment.author_id !== 'string' ||
    typeof comment.author_name !== 'string' ||
    typeof comment.body !== 'string' ||
    typeof comment.quote !== 'string' ||
    !timestamp(comment.created_at)
  )
    throw new Error('O servidor retornou uma referência de comentário inválida.');
  return comment as ConsideredCommentRow;
}

export function revisionFromResponse(value: unknown): DocumentRevisionReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('O servidor retornou uma revisão inválida.');
  const revision = (value as { revision?: unknown }).revision as
    | Partial<DocumentRevisionReceipt>
    | undefined;
  if (
    !revision ||
    typeof revision !== 'object' ||
    Array.isArray(revision) ||
    !exactKeys(revision, [
      'id',
      'document_id',
      'ordinal',
      'author_id',
      'title',
      'filename',
      'markdown',
      'base_revision_id',
      'summary',
      'considered_comment_ids',
      'considered_comments',
      'created_at',
    ]) ||
    typeof revision.id !== 'string' ||
    !uuidPattern.test(revision.id) ||
    typeof revision.document_id !== 'string' ||
    !uuidPattern.test(revision.document_id) ||
    !Number.isSafeInteger(revision.ordinal) ||
    revision.ordinal! < 1 ||
    typeof revision.author_id !== 'string' ||
    typeof revision.title !== 'string' ||
    typeof revision.filename !== 'string' ||
    typeof revision.markdown !== 'string' ||
    (revision.base_revision_id !== null &&
      (typeof revision.base_revision_id !== 'string' ||
        !uuidPattern.test(revision.base_revision_id))) ||
    (revision.summary !== null && typeof revision.summary !== 'string') ||
    !Array.isArray(revision.considered_comment_ids) ||
    revision.considered_comment_ids.length > 100 ||
    revision.considered_comment_ids.some(
      (id) => typeof id !== 'string' || !legacyCommentIdPattern.test(id),
    ) ||
    [...new Set(revision.considered_comment_ids)].sort(compareText).join(',') !==
      revision.considered_comment_ids.join(',') ||
    !Array.isArray(revision.considered_comments) ||
    revision.considered_comments.length !== revision.considered_comment_ids.length ||
    !timestamp(revision.created_at)
  )
    throw new Error('O servidor retornou uma revisão inválida.');
  const consideredComments = revision.considered_comments.map(consideredComment);
  if (
    consideredComments.some(
      (comment, index) => comment.id !== revision.considered_comment_ids![index],
    )
  )
    throw new Error('O servidor retornou referências fora de ordem.');
  return { ...revision, considered_comments: consideredComments } as DocumentRevisionReceipt;
}

export function revisionFromOperationResponse(
  value: unknown,
  operation: RevisionOperation,
) {
  const revision = revisionFromResponse(value);
  if (
    revision.id !== operation.id ||
    revision.document_id !== operation.documentId ||
    revision.author_id !== operation.viewerId ||
    revision.base_revision_id !== operation.baseRevisionId ||
    revision.title !== operation.title ||
    revision.filename !== operation.filename ||
    revision.markdown !== operation.markdown ||
    revision.summary !== (operation.summary || null) ||
    revision.considered_comment_ids.join(',') !==
      operation.consideredCommentIds.join(',')
  )
    throw new Error(
      'A resposta não confirmou esta revisão. Verifique o resultado exato.',
    );
  return revision;
}

export function documentFromInitialRevisionResponse(
  value: unknown,
  operation: ImportOperation,
): DocumentRow {
  const revision = revisionFromResponse(value);
  if (
    revision.id !== operation.id ||
    revision.document_id !== operation.id ||
    revision.ordinal !== 1 ||
    revision.author_id !== operation.viewerId ||
    revision.base_revision_id !== null ||
    revision.title !== operation.title ||
    revision.filename !== operation.filename ||
    revision.markdown !== operation.markdown ||
    revision.summary !== null ||
    revision.considered_comment_ids.length !== 0
  )
    throw new Error(
      'A resposta não confirmou esta importação. Verifique o resultado.',
    );
  return {
    id: operation.id,
    owner_id: operation.viewerId,
    title: revision.title,
    filename: revision.filename,
    markdown: revision.markdown,
    current_revision_id: revision.id,
    revision_ordinal: revision.ordinal,
    revision_author_id: revision.author_id,
    revision_created_at: revision.created_at,
    is_test: operation.isTest ? 1 : 0,
    created_at: revision.created_at,
  };
}
