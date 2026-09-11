import type {
  CommentPage,
  CommentPagination,
  CommentRow,
} from './document-service.ts';

export function mergeComments(current: CommentRow[], incoming: CommentRow[]) {
  return [
    ...new Map(
      [...current, ...incoming].map((entry) => [entry.id, entry]),
    ).values(),
  ].sort(
    (left, right) =>
      left.created_at.localeCompare(right.created_at) ||
      left.id.localeCompare(right.id),
  );
}

function validCursor(cursor: unknown) {
  return (
    typeof cursor === 'string' &&
    cursor.length > 0 &&
    cursor.length <= 512 &&
    /^[A-Za-z0-9_-]+$/.test(cursor)
  );
}

export function commentFromValue(value: unknown, ids = new Set<string>()) {
  const comment = value as Partial<CommentRow> | null;
  if (
    !comment ||
    typeof comment !== 'object' ||
    typeof comment.id !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(comment.id) ||
    ids.has(comment.id) ||
    typeof comment.root_id !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(comment.root_id) ||
    typeof comment.body !== 'string' ||
    typeof comment.quote !== 'string' ||
    (comment.source_start !== null &&
      (!Number.isSafeInteger(comment.source_start) || comment.source_start! < 0)) ||
    typeof comment.created_at !== 'string' ||
    !Number.isFinite(Date.parse(comment.created_at)) ||
    typeof comment.author_id !== 'string' ||
    typeof comment.author_name !== 'string'
  )
    throw new Error('O servidor retornou um comentário inválido.');
  ids.add(comment.id);
  return {
    id: comment.id,
    root_id: comment.root_id,
    body: comment.body,
    quote: comment.quote,
    source_start: comment.source_start,
    created_at: comment.created_at,
    author_id: comment.author_id,
    author_name: comment.author_name,
  } as CommentRow;
}

export function commentPageFromResponse(value: unknown): CommentPage {
  const result = value as {
    comments?: unknown;
    roots?: unknown;
    pagination?: Partial<CommentPagination>;
  } | null;
  if (
    !result ||
    !Array.isArray(result.comments) ||
    !Array.isArray(result.roots) ||
    result.comments.length > 100 ||
    !result.pagination ||
    !validCursor(result.pagination.nextCursor) ||
    (result.pagination.olderCursor !== null &&
      !validCursor(result.pagination.olderCursor)) ||
    typeof result.pagination.hasMore !== 'boolean'
  )
    throw new Error('O servidor retornou uma página de comentários inválida.');
  const ids = new Set<string>();
  const comments = result.comments.map((entry) => commentFromValue(entry, ids));
  const roots = result.roots.map((entry) => commentFromValue(entry, ids));
  if (roots.some((root) => root.root_id !== root.id))
    throw new Error('O servidor retornou a raiz de uma conversa inválida.');
  if (result.pagination.hasMore && comments.length === 0)
    throw new Error('O servidor retornou uma continuação vazia.');
  return {
    comments,
    roots,
    pagination: result.pagination as CommentPagination,
  };
}
