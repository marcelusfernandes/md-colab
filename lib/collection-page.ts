import type {
  DocumentPage,
  DocumentSummary,
  SharePage,
  ShareRow,
} from './document-service.ts';

const cursorPattern = /^[A-Za-z0-9_-]+$/;

function exactKeys(value: object, expected: string[]) {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validCursor(value: unknown) {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 4096 &&
      cursorPattern.test(value))
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function binaryTextCompare(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function newestFirst<T extends { created_at: string }>(
  left: T,
  right: T,
  tie: (left: T, right: T) => number,
) {
  if (left.created_at !== right.created_at)
    return left.created_at > right.created_at ? -1 : 1;
  return -tie(left, right);
}

function documentSummary(value: unknown): DocumentSummary {
  const document = value as Partial<DocumentSummary> | null;
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    !exactKeys(document, [
      'id',
      'owner_id',
      'title',
      'filename',
      'is_test',
      'created_at',
      'owner_name',
      'comment_count',
    ]) ||
    typeof document.id !== 'string' ||
    document.id.length === 0 ||
    typeof document.owner_id !== 'string' ||
    document.owner_id.length === 0 ||
    typeof document.title !== 'string' ||
    typeof document.filename !== 'string' ||
    (document.is_test !== 0 && document.is_test !== 1) ||
    !validTimestamp(document.created_at) ||
    typeof document.owner_name !== 'string' ||
    !Number.isSafeInteger(document.comment_count) ||
    document.comment_count! < 0
  )
    throw new Error('O servidor retornou um resumo de documento inválido.');
  return document as DocumentSummary;
}

function shareRow(value: unknown): ShareRow {
  const share = value as Partial<ShareRow> | null;
  if (
    !share ||
    typeof share !== 'object' ||
    Array.isArray(share) ||
    !exactKeys(share, ['email', 'name', 'created_at']) ||
    typeof share.email !== 'string' ||
    share.email.length > 254 ||
    share.email !== share.email.trim().toLowerCase() ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(share.email) ||
    typeof share.name !== 'string' ||
    !validTimestamp(share.created_at)
  )
    throw new Error('O servidor retornou um convidado inválido.');
  return share as ShareRow;
}

function validateOrder<T extends { created_at: string }>(
  values: T[],
  tie: (left: T, right: T) => number,
) {
  for (let index = 1; index < values.length; index += 1)
    if (newestFirst(values[index - 1]!, values[index]!, tie) > 0)
      throw new Error('O servidor retornou uma página fora de ordem.');
}

export function documentPageFromResponse(value: unknown): DocumentPage {
  const result = value as Partial<DocumentPage> | null;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !exactKeys(result, ['documents', 'nextCursor']) ||
    !Array.isArray(result.documents) ||
    result.documents.length > 50 ||
    !validCursor(result.nextCursor)
  )
    throw new Error('O servidor retornou uma página de documentos inválida.');
  const documents = result.documents.map(documentSummary);
  if (new Set(documents.map((entry) => entry.id)).size !== documents.length)
    throw new Error('O servidor repetiu um documento na mesma página.');
  validateOrder(documents, (left, right) =>
    binaryTextCompare(left.id, right.id),
  );
  if (result.nextCursor !== null && documents.length !== 50)
    throw new Error('O servidor retornou uma continuação incompleta.');
  return { documents, nextCursor: result.nextCursor as string | null };
}

export function sharePageFromResponse(value: unknown): SharePage {
  const result = value as Partial<SharePage> | null;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !exactKeys(result, ['shares', 'nextCursor']) ||
    !Array.isArray(result.shares) ||
    result.shares.length > 100 ||
    !validCursor(result.nextCursor)
  )
    throw new Error('O servidor retornou uma página de convidados inválida.');
  const shares = result.shares.map(shareRow);
  if (new Set(shares.map((entry) => entry.email)).size !== shares.length)
    throw new Error('O servidor repetiu um convidado na mesma página.');
  validateOrder(shares, (left, right) =>
    binaryTextCompare(left.email, right.email),
  );
  if (result.nextCursor !== null && shares.length !== 100)
    throw new Error('O servidor retornou uma continuação incompleta.');
  return { shares, nextCursor: result.nextCursor as string | null };
}

export function mergeDocumentPages(
  current: DocumentSummary[],
  incoming: DocumentSummary[],
) {
  return [
    ...new Map(
      [...current, ...incoming].map((entry) => [entry.id, entry]),
    ).values(),
  ].sort((left, right) =>
    newestFirst(left, right, (leftEntry, rightEntry) =>
      binaryTextCompare(leftEntry.id, rightEntry.id),
    ),
  );
}

export function mergeSharePages(current: ShareRow[], incoming: ShareRow[]) {
  return [
    ...new Map(
      [...current, ...incoming].map((entry) => [entry.email, entry]),
    ).values(),
  ].sort((left, right) =>
    newestFirst(left, right, (leftEntry, rightEntry) =>
      binaryTextCompare(leftEntry.email, rightEntry.email),
    ),
  );
}

export function shareMutationFromResponse(value: unknown) {
  const result = value as {
    share?: unknown;
    emailSubmitted?: unknown;
    emailError?: unknown;
  } | null;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !exactKeys(
      result,
      result.emailError === undefined
        ? ['share', 'emailSubmitted']
        : ['share', 'emailSubmitted', 'emailError'],
    ) ||
    typeof result.emailSubmitted !== 'boolean' ||
    (result.emailError !== undefined && typeof result.emailError !== 'string')
  )
    throw new Error('O servidor não confirmou o convite.');
  return {
    share: shareRow(result.share),
    emailSubmitted: result.emailSubmitted,
    ...(result.emailError === undefined
      ? {}
      : { emailError: result.emailError }),
  };
}

export function revokedEmailFromResponse(
  value: unknown,
  requestedEmail: string,
) {
  const result = value as { revokedEmail?: unknown } | null;
  const expected = requestedEmail.trim().toLowerCase();
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !exactKeys(result, ['revokedEmail']) ||
    result.revokedEmail !== expected
  )
    throw new Error('O servidor não confirmou a remoção do acesso.');
  return expected;
}

export type CollectionAttempt = Readonly<{
  generation: number;
  request: number;
  context: string;
}>;

export function collectionAttemptMatches(
  attempt: CollectionAttempt,
  generation: number,
  request: number,
  context: string,
) {
  return (
    attempt.generation === generation &&
    attempt.request === request &&
    attempt.context === context
  );
}
