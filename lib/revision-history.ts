import type {
  DocumentRevisionSummary,
  RevisionPage,
} from './document-service.ts';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cursorPattern = /^[A-Za-z0-9_-]+$/;

function exactKeys(value: object, expected: string[]) {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function summaryFromValue(value: unknown): DocumentRevisionSummary {
  const revision = value as Partial<DocumentRevisionSummary> | null;
  if (
    !revision ||
    typeof revision !== 'object' ||
    Array.isArray(revision) ||
    !exactKeys(revision, [
      'id',
      'document_id',
      'ordinal',
      'author_id',
      'author_name',
      'title',
      'filename',
      'base_revision_id',
      'summary',
      'created_at',
    ]) ||
    typeof revision.id !== 'string' ||
    !uuidPattern.test(revision.id) ||
    typeof revision.document_id !== 'string' ||
    !uuidPattern.test(revision.document_id) ||
    !Number.isSafeInteger(revision.ordinal) ||
    revision.ordinal! < 1 ||
    typeof revision.author_id !== 'string' ||
    !revision.author_id ||
    typeof revision.author_name !== 'string' ||
    !revision.author_name ||
    typeof revision.title !== 'string' ||
    !revision.title ||
    typeof revision.filename !== 'string' ||
    !revision.filename ||
    (revision.base_revision_id !== null &&
      (typeof revision.base_revision_id !== 'string' ||
        !uuidPattern.test(revision.base_revision_id))) ||
    (revision.summary !== null &&
      (typeof revision.summary !== 'string' ||
        revision.summary.length > 2000)) ||
    !validTimestamp(revision.created_at)
  )
    throw new Error('O servidor retornou metadados de revisão inválidos.');
  return revision as DocumentRevisionSummary;
}

export function revisionPageFromResponse(
  value: unknown,
  documentId: string,
): RevisionPage {
  const result = value as Partial<RevisionPage> | null;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !exactKeys(result, ['revisions', 'nextCursor']) ||
    !Array.isArray(result.revisions) ||
    result.revisions.length > 50 ||
    (result.nextCursor !== null &&
      (typeof result.nextCursor !== 'string' ||
        result.nextCursor.length === 0 ||
        result.nextCursor.length > 4096 ||
        !cursorPattern.test(result.nextCursor)))
  )
    throw new Error('O servidor retornou uma página de revisões inválida.');
  const revisions = result.revisions.map(summaryFromValue);
  if (
    revisions.some((revision) => revision.document_id !== documentId) ||
    new Set(revisions.map((revision) => revision.id)).size !== revisions.length
  )
    throw new Error('O servidor misturou revisões de planos diferentes.');
  for (let index = 1; index < revisions.length; index += 1)
    if (revisions[index - 1]!.ordinal <= revisions[index]!.ordinal)
      throw new Error('O servidor retornou revisões fora de ordem.');
  if (result.nextCursor !== null && revisions.length !== 50)
    throw new Error('O servidor retornou uma continuação incompleta.');
  return { revisions, nextCursor: result.nextCursor as string | null };
}

export function mergeRevisionPages(
  current: DocumentRevisionSummary[],
  incoming: DocumentRevisionSummary[],
) {
  return [
    ...new Map(
      [...current, ...incoming].map((revision) => [revision.id, revision]),
    ).values(),
  ].sort((left, right) => right.ordinal - left.ordinal);
}

export function refreshedRevisionPage(
  current: DocumentRevisionSummary[],
  currentCursor: string | null,
  incoming: DocumentRevisionSummary[],
  incomingCursor: string | null,
) {
  if (current.length === 0)
    return { revisions: incoming, nextCursor: incomingCursor, reset: false };
  if (incoming.some((revision) => revision.id === current[0]!.id))
    return {
      revisions: mergeRevisionPages(current, incoming),
      nextCursor: currentCursor,
      reset: false,
    };
  return { revisions: incoming, nextCursor: incomingCursor, reset: true };
}

export function revisionReadMatches(
  attempt: { request: number; context: string; revisionId: string },
  request: number,
  context: string,
  revisionId: string | null,
) {
  return (
    attempt.request === request &&
    attempt.context === context &&
    attempt.revisionId === revisionId
  );
}

export function documentDestination(parameters: URLSearchParams) {
  const comments = parameters.getAll('comment');
  const revisions = parameters.getAll('revision');
  if (comments.length > 1 || revisions.length > 1)
    return {
      commentId: null,
      revisionId: null,
      error: 'O link repete o destino do documento e não pode ser aberto.',
    };
  const commentId = comments[0] || null;
  const revisionId = revisions[0] || null;
  if (commentId && revisionId)
    return {
      commentId: null,
      revisionId: null,
      error: 'O link mistura comentário e revisão. Abra apenas um destino.',
    };
  if (revisionId && !uuidPattern.test(revisionId))
    return {
      commentId: null,
      revisionId: null,
      error: 'O link aponta para uma revisão inválida.',
    };
  return { commentId, revisionId, error: '' };
}
