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
  let row: DocumentRow;
  try {
    row = documentFromValue((value as { document?: unknown }).document);
  } catch {
    throw new Error(
      'A resposta não confirmou esta importação. Verifique o resultado.',
    );
  }
  if (
    row.id !== operation.id ||
    row.owner_id !== operation.viewerId ||
    row.markdown !== operation.markdown ||
    row.filename !== operation.filename ||
    row.title !== operation.title ||
    row.current_revision_id !== operation.id ||
    row.revision_ordinal !== 1 ||
    row.revision_author_id !== operation.viewerId ||
    row.revision_created_at !== row.created_at ||
    row.is_test !== (operation.isTest ? 1 : 0) ||
    typeof row.created_at !== 'string' ||
    !row.created_at ||
    !Number.isFinite(Date.parse(row.created_at))
  )
    throw new Error(
      'A resposta não confirmou esta importação. Verifique o resultado.',
    );
  return row;
}

export function documentFromValue(value: unknown): DocumentRow {
  const row = value as Partial<DocumentRow> | null;
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    Object.keys(row).sort().join(',') !==
      [
        'id',
        'owner_id',
        'title',
        'filename',
        'markdown',
        'current_revision_id',
        'revision_ordinal',
        'revision_author_id',
        'revision_created_at',
        'is_test',
        'created_at',
      ]
        .sort()
        .join(',') ||
    typeof row.id !== 'string' ||
    typeof row.owner_id !== 'string' ||
    typeof row.title !== 'string' ||
    typeof row.filename !== 'string' ||
    typeof row.markdown !== 'string' ||
    typeof row.current_revision_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      row.current_revision_id,
    ) ||
    !Number.isSafeInteger(row.revision_ordinal) ||
    row.revision_ordinal! < 1 ||
    typeof row.revision_author_id !== 'string' ||
    !row.revision_author_id ||
    typeof row.revision_created_at !== 'string' ||
    !Number.isFinite(Date.parse(row.revision_created_at)) ||
    (row.is_test !== 0 && row.is_test !== 1) ||
    typeof row.created_at !== 'string' ||
    !Number.isFinite(Date.parse(row.created_at))
  )
    throw new Error('O servidor retornou um documento inválido.');
  return row as DocumentRow;
}
