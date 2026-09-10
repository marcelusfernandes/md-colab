import {
  activeShareLimit,
  commentLimit,
  ownedDocumentLimit,
  quotaExceeded,
  type WriteQuotaEnvironment,
} from './write-quotas.ts';

export type Viewer = {
  id: string;
  email: string;
  name: string;
  isTest?: boolean;
};
export type DocumentRow = {
  id: string;
  owner_id: string;
  title: string;
  filename: string;
  markdown: string;
  is_test: number;
  created_at: string;
};
export type CommentRow = {
  id: string;
  root_id: string;
  body: string;
  quote: string;
  source_start: number | null;
  created_at: string;
  author_id: string;
  author_name: string;
};
export type CommentPagination = {
  olderCursor: string | null;
  nextCursor: string;
  hasMore: boolean;
};
export type CommentPage = {
  comments: CommentRow[];
  roots: CommentRow[];
  pagination: CommentPagination;
};
export type CommentPageQuery = {
  before?: string;
  after?: string;
};
export type ShareRow = { email: string; name: string; created_at: string };
export type DocumentSummary = Omit<DocumentRow, 'markdown'> & {
  owner_name: string;
  comment_count: number;
};
export type CursorPageQuery = { cursor?: string };
export type DocumentPage = {
  documents: DocumentSummary[];
  nextCursor: string | null;
};
export type SharePage = { shares: ShareRow[]; nextCursor: string | null };
const documentPageSize = 50;
const sharePageSize = 100;
const commentPageSize = 100;
const publicCommentFields =
  'c.id,COALESCE(c.root_id,c.id) AS root_id,c.body,c.quote,c.source_start,c.created_at,c.author_id,u.name AS author_name';
type CommentCursorKind = 'before' | 'after';
type CommentCursor = {
  v: 1;
  d: string;
  k: CommentCursorKind;
  s: number;
};
type SequencedCommentRow = CommentRow & { transport_sequence: number };
type DocumentCursor = {
  v: 1;
  type: 'documents';
  direction: 'older';
  viewerId: string;
  isTest: boolean;
  createdAt: string;
  id: string;
};
type ShareCursor = {
  v: 1;
  type: 'shares';
  direction: 'older';
  documentId: string;
  viewerId: string;
  isTest: boolean;
  createdAt: string;
  email: string;
};

function cursorBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function cursorText(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function validCursorText(value: string) {
  return (
    value.length > 0 && value.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function validCursorTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function encodeDocumentCursor(cursor: DocumentCursor) {
  return cursorBase64(JSON.stringify(cursor));
}

function decodeDocumentCursor(value: string, viewer: Viewer) {
  try {
    if (!validCursorText(value)) throw new Error();
    const cursor = JSON.parse(cursorText(value)) as Partial<DocumentCursor>;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !==
        'createdAt,direction,id,isTest,type,v,viewerId' ||
      cursor.v !== 1 ||
      cursor.type !== 'documents' ||
      cursor.direction !== 'older' ||
      cursor.viewerId !== viewer.id ||
      cursor.isTest !== Boolean(viewer.isTest) ||
      !validCursorTimestamp(cursor.createdAt) ||
      typeof cursor.id !== 'string' ||
      cursor.id.length === 0 ||
      encodeDocumentCursor(cursor as DocumentCursor) !== value
    )
      throw new Error();
    return cursor as DocumentCursor;
  } catch {
    throw new HttpError(400, 'Cursor de documentos inválido.');
  }
}

function encodeShareCursor(cursor: ShareCursor) {
  return cursorBase64(JSON.stringify(cursor));
}

function decodeShareCursor(value: string, documentId: string, viewer: Viewer) {
  try {
    if (!validCursorText(value)) throw new Error();
    const cursor = JSON.parse(cursorText(value)) as Partial<ShareCursor>;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !==
        'createdAt,direction,documentId,email,isTest,type,v,viewerId' ||
      cursor.v !== 1 ||
      cursor.type !== 'shares' ||
      cursor.direction !== 'older' ||
      cursor.documentId !== documentId ||
      cursor.viewerId !== viewer.id ||
      cursor.isTest !== Boolean(viewer.isTest) ||
      !validCursorTimestamp(cursor.createdAt) ||
      typeof cursor.email !== 'string' ||
      validEmail(cursor.email) !== cursor.email ||
      encodeShareCursor(cursor as ShareCursor) !== value
    )
      throw new Error();
    return cursor as ShareCursor;
  } catch {
    throw new HttpError(400, 'Cursor de convidados inválido.');
  }
}

function encodeCommentCursor(
  documentId: string,
  kind: CommentCursorKind,
  sequence: number,
) {
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new Error('Comment sequence is outside the safe cursor range.');
  return cursorBase64(
    JSON.stringify({ v: 1, d: documentId, k: kind, s: sequence }),
  );
}

function decodeCommentCursor(
  value: string,
  documentId: string,
  kind: CommentCursorKind,
) {
  try {
    if (
      value.length === 0 ||
      value.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    )
      throw new Error();
    const cursor = JSON.parse(cursorText(value)) as Partial<CommentCursor>;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !== 'd,k,s,v' ||
      cursor.v !== 1 ||
      cursor.d !== documentId ||
      cursor.k !== kind ||
      !Number.isSafeInteger(cursor.s) ||
      (kind === 'before' ? cursor.s! < 1 : cursor.s! < 0) ||
      encodeCommentCursor(cursor.d, cursor.k, cursor.s!) !== value
    )
      throw new Error();
    return cursor.s!;
  } catch {
    throw new HttpError(400, 'Cursor de comentários inválido.');
  }
}

function publicComments(rows: SequencedCommentRow[]) {
  return rows
    .map(({ transport_sequence: _sequence, ...comment }) => comment)
    .sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.id.localeCompare(right.id),
    );
}

function sequenceOf(row: SequencedCommentRow | undefined) {
  const sequence = row?.transport_sequence ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new Error('Comment sequence is outside the safe cursor range.');
  return sequence;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}
export function validEmail(value: unknown) {
  if (typeof value !== 'string')
    throw new HttpError(400, 'Informe um e-mail válido.');
  const email = normalizeEmail(value);
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
    throw new HttpError(400, 'Informe um e-mail válido.');
  return email;
}
export function requiredText(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new HttpError(400, label + ' inválido.');
  return value.trim();
}
export type DocumentInput = {
  markdown: string;
  filename: string;
  title: string;
  requestedTitle: string | null;
};
type ManualDocumentInput = DocumentInput & {
  id: string;
  authorId: string;
};
export function documentInput(
  input: Record<string, unknown>,
  exact = false,
): DocumentInput {
  if (
    exact &&
    Object.keys(input).some(
      (key) => !['markdown', 'filename', 'title'].includes(key),
    )
  )
    throw new HttpError(
      400,
      'A publicação aceita somente Markdown, nome e título.',
    );
  requiredText(input.markdown, 'Markdown', 1024 * 1024);
  const markdown = input.markdown as string;
  if (new TextEncoder().encode(markdown).length > 1024 * 1024)
    throw new HttpError(413, 'O arquivo deve ter no máximo 1 MB.');
  const filename = requiredText(input.filename, 'Nome do arquivo', 255);
  const requestedTitle = exact
    ? input.title === undefined
      ? null
      : requiredText(input.title, 'Título', 240)
    : typeof input.title === 'string' && input.title.trim()
      ? requiredText(input.title, 'Título', 240)
      : null;
  const title =
    requestedTitle ??
    (
      markdown.match(/^#\s+(.+)$/m)?.[1] ??
      filename.replace(/\.(md|markdown)$/i, '')
    ).slice(0, 240);
  return { markdown, filename, title, requestedTitle };
}
function manualDocumentInput(
  input: Record<string, unknown>,
): ManualDocumentInput {
  if (
    Object.keys(input).some(
      (key) =>
        !['id', 'authorId', 'markdown', 'filename', 'title'].includes(key),
    )
  )
    throw new HttpError(
      400,
      'A importação aceita somente identificador, autor, Markdown, nome e título.',
    );
  const id = requiredText(input.id, 'Identificador da importação', 36);
  if (
    input.id !== id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    throw new HttpError(400, 'Identificador da importação inválido.');
  const authorId = requiredText(input.authorId, 'Autor da importação', 128);
  const documentFields: Record<string, unknown> = {
    markdown: input.markdown,
    filename: input.filename,
  };
  if (input.title !== undefined) documentFields.title = input.title;
  return { id, authorId, ...documentInput(documentFields, true) };
}
export class DocumentService {
  constructor(
    private db: D1Database,
    public viewer: Viewer,
    private quotaEnvironment: WriteQuotaEnvironment = {},
  ) {
    viewer.email = normalizeEmail(viewer.email);
  }
  async registerViewer() {
    await this.db
      .prepare(
        'INSERT INTO users (id,email,name) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name',
      )
      .bind(this.viewer.id, this.viewer.email, this.viewer.name)
      .run();
  }
  async list(query: CursorPageQuery = {}): Promise<DocumentPage> {
    const cursor =
      query.cursor === undefined
        ? null
        : decodeDocumentCursor(query.cursor, this.viewer);
    const statement = this.db
      .prepare(`SELECT d.id,d.title,d.filename,d.owner_id,d.is_test,d.created_at,u.name AS owner_name,
      (SELECT count(*) FROM comments c WHERE c.document_id=d.id) AS comment_count
      FROM documents d JOIN users u ON u.id=d.owner_id
      WHERE d.is_test=? AND (d.owner_id=? OR EXISTS(SELECT 1 FROM shares s WHERE s.document_id=d.id AND s.email=?))
      ${cursor ? 'AND (d.created_at<? OR (d.created_at=? AND d.id<?))' : ''}
      ORDER BY d.created_at DESC,d.id DESC LIMIT ?`);
    const base = [
      this.viewer.isTest ? 1 : 0,
      this.viewer.id,
      this.viewer.isTest ? '' : this.viewer.email,
    ];
    const rows = (
      await statement
        .bind(
          ...base,
          ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
          documentPageSize + 1,
        )
        .all<DocumentSummary>()
    ).results;
    const documents = rows.slice(0, documentPageSize);
    const last = documents.at(-1);
    return {
      documents,
      nextCursor:
        rows.length > documentPageSize && last
          ? encodeDocumentCursor({
              v: 1,
              type: 'documents',
              direction: 'older',
              viewerId: this.viewer.id,
              isTest: Boolean(this.viewer.isTest),
              createdAt: last.created_at,
              id: last.id,
            })
          : null,
    };
  }
  async document(id: string, ownerOnly = false) {
    const doc = await this.db
      .prepare(`SELECT d.* FROM documents d WHERE d.id=? AND d.is_test=? AND
      (d.owner_id=? OR (?=0 AND (?=1 OR EXISTS(SELECT 1 FROM shares s WHERE s.document_id=d.id AND s.email=?))))`)
      .bind(
        id,
        this.viewer.isTest ? 1 : 0,
        this.viewer.id,
        ownerOnly ? 1 : 0,
        this.viewer.isTest ? 1 : 0,
        this.viewer.isTest ? '' : this.viewer.email,
      )
      .first<DocumentRow>();
    if (!doc)
      throw new HttpError(404, 'Documento indisponível para esta conta.');
    return doc;
  }
  async create(input: Record<string, unknown>) {
    const { id, authorId, markdown, filename, title } =
      manualDocumentInput(input);
    if (authorId !== this.viewer.id)
      throw new HttpError(
        409,
        'Esta importação pertence a outra sessão e não pode ser reutilizada.',
      );
    const isTest = this.viewer.isTest ? 1 : 0;
    const existing = await this.db
      .prepare('SELECT * FROM documents WHERE id=?')
      .bind(id)
      .first<DocumentRow>();
    if (existing) {
      if (
        existing.owner_id !== authorId ||
        existing.is_test !== isTest ||
        existing.markdown !== markdown ||
        existing.filename !== filename ||
        existing.title !== title
      )
        throw new HttpError(
          409,
          'Esta importação já foi usada com outro autor, contexto ou conteúdo.',
        );
      await this.document(id);
      return existing;
    }
    const limit = ownedDocumentLimit(this.quotaEnvironment);
    await this.db
      .prepare(
        `INSERT INTO documents (id,owner_id,title,filename,markdown,created_at,is_test)
         SELECT ?,?,?,?,?,?,? WHERE
         NOT EXISTS(SELECT 1 FROM documents WHERE id=?) AND
         (SELECT count(*) FROM documents WHERE owner_id=? AND is_test=?)<?`,
      )
      .bind(
        id,
        authorId,
        title,
        filename,
        markdown,
        new Date().toISOString(),
        isTest,
        id,
        authorId,
        isTest,
        limit,
      )
      .run();
    const document = await this.db
      .prepare('SELECT * FROM documents WHERE id=?')
      .bind(id)
      .first<DocumentRow>();
    if (!document)
      throw quotaExceeded(
        'Você atingiu o limite total de planos próprios. Peça ao operador para ampliar a configuração.',
      );
    if (
      document.owner_id !== authorId ||
      document.is_test !== isTest ||
      document.markdown !== markdown ||
      document.filename !== filename ||
      document.title !== title
    )
      throw new HttpError(
        409,
        'Esta importação já foi usada com outro autor, contexto ou conteúdo.',
      );
    return document;
  }
  async comments(
    id: string,
    query: CommentPageQuery = {},
  ): Promise<CommentPage> {
    await this.document(id);
    if (query.before !== undefined && query.after !== undefined)
      throw new HttpError(400, 'Use apenas um cursor de comentários.');
    if (query.before !== undefined) {
      const boundary = decodeCommentCursor(query.before, id, 'before');
      const rows = (
        await this.db
          .prepare(
            `SELECT ${publicCommentFields},c.sequence AS transport_sequence
             FROM comments c JOIN users u ON u.id=c.author_id
             WHERE c.document_id=? AND c.sequence<?
             ORDER BY c.sequence DESC LIMIT ?`,
          )
          .bind(id, boundary, commentPageSize + 1)
          .all<SequencedCommentRow>()
      ).results;
      const page = rows.slice(0, commentPageSize);
      const hasOlder = rows.length > commentPageSize;
      return {
        comments: publicComments(page),
        roots: await this.commentRoots(id, page),
        pagination: {
          olderCursor:
            hasOlder && page.length > 0
              ? encodeCommentCursor(id, 'before', sequenceOf(page.at(-1)))
              : null,
          nextCursor: encodeCommentCursor(id, 'after', sequenceOf(page[0])),
          hasMore: false,
        },
      };
    }
    if (query.after !== undefined) {
      const boundary = decodeCommentCursor(query.after, id, 'after');
      const rows = (
        await this.db
          .prepare(
            `SELECT ${publicCommentFields},c.sequence AS transport_sequence
             FROM comments c JOIN users u ON u.id=c.author_id
             WHERE c.document_id=? AND c.sequence>?
             ORDER BY c.sequence LIMIT ?`,
          )
          .bind(id, boundary, commentPageSize + 1)
          .all<SequencedCommentRow>()
      ).results;
      const page = rows.slice(0, commentPageSize);
      return {
        comments: publicComments(page),
        roots: await this.commentRoots(id, page),
        pagination: {
          olderCursor: null,
          nextCursor: encodeCommentCursor(
            id,
            'after',
            page.length > 0 ? sequenceOf(page.at(-1)) : boundary,
          ),
          hasMore: rows.length > commentPageSize,
        },
      };
    }
    const rows = (
      await this.db
        .prepare(
          `SELECT ${publicCommentFields},c.sequence AS transport_sequence
           FROM comments c JOIN users u ON u.id=c.author_id
           WHERE c.document_id=? ORDER BY c.sequence DESC LIMIT ?`,
        )
        .bind(id, commentPageSize + 1)
        .all<SequencedCommentRow>()
    ).results;
    const page = rows.slice(0, commentPageSize);
    const hasOlder = rows.length > commentPageSize;
    return {
      comments: publicComments(page),
      roots: await this.commentRoots(id, page),
      pagination: {
        olderCursor:
          hasOlder && page.length > 0
            ? encodeCommentCursor(id, 'before', sequenceOf(page.at(-1)))
            : null,
        nextCursor: encodeCommentCursor(id, 'after', sequenceOf(page[0])),
        hasMore: false,
      },
    };
  }

  private async commentRoots(id: string, page: SequencedCommentRow[]) {
    const rootIds = [
      ...new Set(
        page
          .map((entry) => entry.root_id)
          .filter(
            (rootId) =>
              rootId !== undefined &&
              !page.some((entry) => entry.id === rootId),
          ),
      ),
    ];
    if (rootIds.length === 0) return [];
    const placeholders = rootIds.map(() => '?').join(',');
    return (
      await this.db
        .prepare(
          `SELECT ${publicCommentFields} FROM comments c JOIN users u ON u.id=c.author_id
           WHERE c.document_id=? AND c.id IN (${placeholders})`,
        )
        .bind(id, ...rootIds)
        .all<CommentRow>()
    ).results;
  }

  async comment(id: string, commentId: string) {
    await this.document(id);
    if (!/^[0-9a-f-]{36}$/i.test(commentId))
      throw new HttpError(400, 'Identificador inválido.');
    return this.db
      .prepare(
        `SELECT ${publicCommentFields} FROM comments c JOIN users u ON u.id=c.author_id
         WHERE c.document_id=? AND c.id=?`,
      )
      .bind(id, commentId)
      .first<CommentRow>();
  }
  async addComment(id: string, input: Record<string, unknown>) {
    const doc = await this.document(id);
    const authorId = requiredText(
      input.authorId,
      'Identidade do comentário',
      128,
    );
    if (authorId !== this.viewer.id)
      throw new HttpError(
        409,
        'Este envio pertence a outra sessão. Revise o comentário antes de tentar novamente.',
      );
    const body = requiredText(input.body, 'Comentário', 5000);
    const quote = typeof input.quote === 'string' ? input.quote.trim() : '';
    if (quote.length > 4000)
      throw new HttpError(400, 'Selecione um trecho menor para comentar.');
    const sourceStart =
      input.sourceStart === null || input.sourceStart === undefined
        ? null
        : input.sourceStart;
    if (
      sourceStart !== null &&
      (typeof sourceStart !== 'number' ||
        !Number.isInteger(sourceStart) ||
        sourceStart < 0 ||
        sourceStart >= doc.markdown.length)
    )
      throw new HttpError(400, 'Trecho inválido. Selecione novamente.');
    const commentId = requiredText(input.id, 'Identificador do comentário', 64);
    if (!/^[0-9a-f-]{36}$/i.test(commentId))
      throw new HttpError(400, 'Identificador inválido.');
    if (
      Object.keys(input).some(
        (key) =>
          ![
            'id',
            'authorId',
            'body',
            'quote',
            'sourceStart',
            'rootId',
          ].includes(key),
      )
    )
      throw new HttpError(400, 'Comentário inválido.');
    const requestedRootId =
      input.rootId === undefined || input.rootId === null
        ? null
        : requiredText(input.rootId, 'Conversa', 64);
    if (requestedRootId && !/^[0-9a-f-]{36}$/i.test(requestedRootId))
      throw new HttpError(400, 'Conversa inválida.');
    // A reply never carries a fresh anchor: the root owns the preserved context.
    let rootId = commentId;
    if (requestedRootId) {
      const root = await this.db
        .prepare(
          `SELECT id,document_id,COALESCE(root_id,id) AS root_id
           FROM comments WHERE id=? AND document_id=?`,
        )
        .bind(requestedRootId, id)
        .first<{ id: string; document_id: string; root_id: string }>();
      if (!root || root.id !== root.root_id)
        throw new HttpError(404, 'Conversa indisponível.');
      if (quote !== '' || sourceStart !== null)
        throw new HttpError(
          400,
          'Uma resposta preserva o trecho e a origem da conversa raiz.',
        );
      rootId = root.id;
    }
    const existing = await this.db
      .prepare(
        `SELECT ${publicCommentFields},c.document_id FROM comments c JOIN users u ON u.id=c.author_id WHERE c.id=?`,
      )
      .bind(commentId)
      .first<CommentRow & { document_id: string }>();
    if (existing) {
      if (
        existing.author_id !== authorId ||
        existing.document_id !== id ||
        existing.body !== body ||
        existing.quote !== quote ||
        existing.source_start !== sourceStart ||
        existing.root_id !== rootId
      )
        throw new HttpError(
          409,
          'Este comentário já foi enviado com outro conteúdo.',
        );
      await this.document(id);
      return existing;
    }
    const limit = commentLimit(this.quotaEnvironment);
    await this.db
      .prepare(
        `INSERT INTO comments (id,document_id,author_id,body,quote,source_start,root_id,created_at)
         SELECT ?,?,?,?,?,?,?,? WHERE
         NOT EXISTS(SELECT 1 FROM comments WHERE id=?) AND
         (SELECT count(*) FROM comments WHERE document_id=?)<? AND
         EXISTS(SELECT 1 FROM documents d WHERE d.id=? AND d.is_test=? AND
           (d.owner_id=? OR ?=1 OR EXISTS(SELECT 1 FROM shares s WHERE s.document_id=d.id AND s.email=?)))`,
      )
      .bind(
        commentId,
        id,
        authorId,
        body,
        quote,
        sourceStart,
        rootId,
        new Date().toISOString(),
        commentId,
        id,
        limit,
        id,
        this.viewer.isTest ? 1 : 0,
        this.viewer.id,
        this.viewer.isTest ? 1 : 0,
        this.viewer.isTest ? '' : this.viewer.email,
      )
      .run();
    // Access can be revoked while the write is in flight. Do not disclose the
    // persisted row in the response unless this request still has access.
    await this.document(id);
    const comment = await this.db
      .prepare(
        `SELECT ${publicCommentFields},c.document_id FROM comments c JOIN users u ON u.id=c.author_id WHERE c.id=?`,
      )
      .bind(commentId)
      .first<CommentRow & { document_id: string }>();
    if (!comment)
      throw quotaExceeded(
        'Este plano atingiu o limite total de comentários. Peça ao operador para ampliar a configuração.',
      );
    if (
      comment.author_id !== authorId ||
      comment.document_id !== id ||
      comment.body !== body ||
      comment.quote !== quote ||
      comment.source_start !== sourceStart ||
      comment.root_id !== rootId
    )
      throw new HttpError(
        409,
        'Este comentário já foi enviado com outro conteúdo.',
      );
    return comment;
  }
  async shares(id: string, query: CursorPageQuery = {}): Promise<SharePage> {
    await this.document(id, true);
    const cursor =
      query.cursor === undefined
        ? null
        : decodeShareCursor(query.cursor, id, this.viewer);
    const rows = (
      await this.db
        .prepare(`SELECT email,name,created_at FROM shares WHERE document_id=?
          ${cursor ? 'AND (created_at<? OR (created_at=? AND email<?))' : ''}
          ORDER BY created_at DESC,email DESC LIMIT ?`)
        .bind(
          id,
          ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.email] : []),
          sharePageSize + 1,
        )
        .all<ShareRow>()
    ).results;
    const shares = rows.slice(0, sharePageSize);
    const last = shares.at(-1);
    return {
      shares,
      nextCursor:
        rows.length > sharePageSize && last
          ? encodeShareCursor({
              v: 1,
              type: 'shares',
              direction: 'older',
              documentId: id,
              viewerId: this.viewer.id,
              isTest: Boolean(this.viewer.isTest),
              createdAt: last.created_at,
              email: last.email,
            })
          : null,
    };
  }
  async share(id: string, input: Record<string, unknown>): Promise<ShareRow> {
    await this.document(id, true);
    const email = validEmail(requiredText(input.email, 'E-mail', 254));
    if (email === this.viewer.email)
      throw new HttpError(400, 'Você já tem acesso como dono.');
    const name =
      typeof input.name === 'string' && input.name.trim()
        ? requiredText(input.name, 'Nome', 120)
        : email;
    const existing = await this.db
      .prepare(
        'SELECT email,name,created_at FROM shares WHERE document_id=? AND email=?',
      )
      .bind(id, email)
      .first<ShareRow>();
    if (existing) {
      if (existing.name !== name)
        throw new HttpError(
          409,
          'Este convite já existe com outro nome.',
        );
      await this.document(id, true);
      return existing;
    }
    const limit = activeShareLimit(this.quotaEnvironment);
    await this.db
      .prepare(
        `INSERT INTO shares (document_id,email,name,created_at)
         SELECT ?,?,?,? WHERE
         NOT EXISTS(SELECT 1 FROM shares WHERE document_id=? AND email=?) AND
         (SELECT count(*) FROM shares WHERE document_id=?)<?`,
      )
      .bind(
        id,
        email,
        name,
        new Date().toISOString(),
        id,
        email,
        id,
        limit,
      )
      .run();
    await this.document(id, true);
    const share = await this.db
      .prepare(
        'SELECT email,name,created_at FROM shares WHERE document_id=? AND email=?',
      )
      .bind(id, email)
      .first<ShareRow>();
    if (!share)
      throw quotaExceeded(
        'Este plano atingiu o limite total de convidados ativos. Revogue um acesso antes de convidar outra pessoa.',
      );
    if (share.name !== name)
      throw new HttpError(409, 'Este convite já existe com outro nome.');
    return share;
  }
  async revoke(id: string, email: string) {
    await this.document(id, true);
    const normalizedEmail = normalizeEmail(email);
    await this.db
      .prepare('DELETE FROM shares WHERE document_id=? AND email=?')
      .bind(id, normalizedEmail)
      .run();
    await this.db
      .prepare('DELETE FROM magic_links WHERE document_id=? AND email=?')
      .bind(id, normalizedEmail)
      .run();
    return normalizedEmail;
  }
  async people(query: string) {
    if (query.length < 2) return [];
    const like = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
    return (
      await this.db
        .prepare(`SELECT DISTINCT s.email,s.name FROM shares s JOIN documents d ON d.id=s.document_id
      WHERE d.owner_id=? AND (s.name LIKE ? ESCAPE '\\' OR s.email LIKE ? ESCAPE '\\') LIMIT 8`)
        .bind(this.viewer.id, like, like)
        .all()
    ).results;
  }
}
