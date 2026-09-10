import type { DocumentRow, Viewer } from './document-service.ts';

export type ImportOperationStatus =
  | 'sending'
  | 'uncertain'
  | 'error'
  | 'blocked';

export type ImportOperation = Readonly<{
  id: string;
  viewerId: string;
  isTest: boolean;
  filename: string;
  markdown: string;
  title: string;
  status: ImportOperationStatus;
  message: string;
}>;

export type ImportAttempt = Readonly<{
  generation: number;
  request: number;
}>;

export type ImportSession = Readonly<{
  viewer: Viewer;
  canCreate: boolean;
}>;

export function inferredDocumentTitle(markdown: string, filename: string) {
  return (
    markdown.match(/^#\s+(.+)$/m)?.[1] ??
    filename.replace(/\.(md|markdown)$/i, '')
  ).slice(0, 240);
}

export function createImportOperation(input: {
  viewerId: string;
  isTest: boolean;
  filename: string;
  markdown: string;
}): ImportOperation {
  const filename = input.filename.trim();
  return Object.freeze({
    id: crypto.randomUUID(),
    viewerId: input.viewerId,
    isTest: input.isTest,
    filename,
    markdown: input.markdown,
    title: inferredDocumentTitle(input.markdown, filename),
    status: 'sending' as const,
    message: '',
  });
}

export function updateImportOperation(
  operation: ImportOperation,
  status: ImportOperationStatus,
  message: string,
): ImportOperation {
  return Object.freeze({ ...operation, status, message });
}

export function importOperationRequest(operation: ImportOperation) {
  return {
    id: operation.id,
    authorId: operation.viewerId,
    markdown: operation.markdown,
    filename: operation.filename,
  };
}

export function importSessionFromResponse(value: unknown): ImportSession {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('A sessão retornada pelo servidor é inválida.');
  const result = value as { viewer?: unknown; canCreate?: unknown };
  if (
    !result.viewer ||
    typeof result.viewer !== 'object' ||
    Array.isArray(result.viewer) ||
    typeof result.canCreate !== 'boolean'
  )
    throw new Error('A sessão retornada pelo servidor é inválida.');
  const viewer = result.viewer as Partial<Viewer>;
  if (
    typeof viewer.id !== 'string' ||
    !viewer.id.trim() ||
    viewer.id !== viewer.id.trim() ||
    typeof viewer.email !== 'string' ||
    typeof viewer.name !== 'string' ||
    (viewer.isTest !== undefined && typeof viewer.isTest !== 'boolean')
  )
    throw new Error('A sessão retornada pelo servidor é inválida.');
  return { viewer: viewer as Viewer, canCreate: result.canCreate };
}

export function importOperationMatchesSession(
  operation: ImportOperation,
  session: ImportSession,
) {
  return (
    session.canCreate &&
    session.viewer.id === operation.viewerId &&
    Boolean(session.viewer.isTest) === operation.isTest
  );
}

export function importAttemptMatches(
  operation: ImportOperation,
  currentOperation: ImportOperation | null,
  attempt: ImportAttempt,
  currentGeneration: number,
  currentRequest: number,
) {
  return (
    currentOperation?.id === operation.id &&
    attempt.generation === currentGeneration &&
    attempt.request === currentRequest
  );
}

export function documentFromImportResponse(
  value: unknown,
  operation: ImportOperation,
): DocumentRow {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(
      'A resposta não confirmou esta importação. Verifique o resultado.',
    );
  const document = (value as { document?: unknown }).document;
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error(
      'A resposta não confirmou esta importação. Verifique o resultado.',
    );
  const row = document as Partial<DocumentRow>;
  if (
    row.id !== operation.id ||
    row.owner_id !== operation.viewerId ||
    row.markdown !== operation.markdown ||
    row.filename !== operation.filename ||
    row.title !== operation.title ||
    row.is_test !== (operation.isTest ? 1 : 0) ||
    typeof row.created_at !== 'string' ||
    !row.created_at ||
    !Number.isFinite(Date.parse(row.created_at))
  )
    throw new Error(
      'A resposta não confirmou esta importação. Verifique o resultado.',
    );
  return row as DocumentRow;
}
