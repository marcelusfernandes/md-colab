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
  current_revision_id: string;
  revision_ordinal: number;
  revision_author_id: string;
  revision_created_at: string;
  is_test: number;
  created_at: string;
};
export type CommentRow = {
  id: string;
  root_id: string;
  body: string;
  quote: string;
  source_start: number | null;
  source_revision_id: string;
  created_at: string;
  author_id: string;
  author_name: string;
};
export type DocumentRevisionRow = {
  id: string;
  document_id: string;
  ordinal: number;
  author_id: string;
  title: string;
  filename: string;
  markdown: string;
  created_at: string;
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
export type ConversationFilter = 'all' | 'open' | 'unanswered' | 'closed';
export type ConversationEventAction =
  | 'close'
  | 'reopen'
  | 'follow'
  | 'refute'
  | 'defer';
export type ConversationEventRow = {
  id: string;
  root_id: string;
  actor_id: string;
  actor_name: string;
  base_version: number;
  version: number;
  action: ConversationEventAction;
  state: 'open' | 'closed';
  decision: 'follow' | 'refute' | 'defer' | null;
  decision_reason: string | null;
  reason: string | null;
  created_at: string;
};
export type ConversationRow = {
  root: CommentRow;
  replies: CommentRow[];
  repliesCursor: string | null;
  replyCount: number;
  state: 'open' | 'closed';
  decision: 'follow' | 'refute' | 'defer' | null;
  decisionReason: string | null;
  version: number;
};
export type DirectedCommentContext = {
  target: CommentRow;
  conversation: ConversationRow;
};
export type ConversationPageQuery = {
  filter?: ConversationFilter;
  cursor?: string;
};
export type ConversationPage = {
  conversations: ConversationRow[];
  nextCursor: string | null;
  changeCursor: string;
};
export type ShareRow = { email: string; name: string; created_at: string };
export type DocumentSummary = Pick<
  DocumentRow,
  'id' | 'owner_id' | 'title' | 'filename' | 'is_test' | 'created_at'
> & {
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
const conversationPageSize = 50;
const conversationReplyPreviewSize = 3;
const conversationReplyPageSize = 50;
const conversationEventPageSize = 50;
const conversationChangePageSize = 99;
const publicCommentFields =
  'c.id,COALESCE(c.root_id,c.id) AS root_id,c.body,c.quote,c.source_start,c.source_revision_id,c.created_at,c.author_id,u.name AS author_name';
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
type ConversationCursor = {
  v: 1;
  type: 'conversations';
  direction: 'older';
  documentId: string;
  filter: ConversationFilter;
  sequence: number;
};
type ConversationChangeCursor = {
  v: 1;
  type: 'conversation-changes';
  documentId: string;
  sequence: number;
};
type ConversationChildCursor = {
  v: 1;
  type: 'conversation-replies' | 'conversation-events';
  documentId: string;
  rootId: string;
  sequence: number;
};
type ConversationRootRow = SequencedCommentRow & {
  state: 'open' | 'closed';
  decision: 'follow' | 'refute' | 'defer' | null;
  decision_reason: string | null;
  version: number;
  reply_count: number;
};
type SequencedConversationEventRow = ConversationEventRow & {
  transport_sequence: number;
  document_id: string;
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

function validSequence(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function encodeConversationCursor(cursor: ConversationCursor) {
  return cursorBase64(JSON.stringify(cursor));
}

function decodeConversationCursor(
  value: string,
  documentId: string,
  filter: ConversationFilter,
) {
  try {
    if (!validCursorText(value)) throw new Error();
    const cursor = JSON.parse(cursorText(value)) as Partial<ConversationCursor>;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !==
        'direction,documentId,filter,sequence,type,v' ||
      cursor.v !== 1 ||
      cursor.type !== 'conversations' ||
      cursor.direction !== 'older' ||
      cursor.documentId !== documentId ||
      cursor.filter !== filter ||
      !validSequence(cursor.sequence, 1) ||
      encodeConversationCursor(cursor as ConversationCursor) !== value
    )
      throw new Error();
    return cursor.sequence!;
  } catch {
    throw new HttpError(400, 'Cursor de conversas inválido.');
  }
}

function encodeConversationChangeCursor(cursor: ConversationChangeCursor) {
  return cursorBase64(JSON.stringify(cursor));
}

function decodeConversationChangeCursor(value: string, documentId: string) {
  try {
    if (!validCursorText(value)) throw new Error();
    const cursor = JSON.parse(
      cursorText(value),
    ) as Partial<ConversationChangeCursor>;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !== 'documentId,sequence,type,v' ||
      cursor.v !== 1 ||
      cursor.type !== 'conversation-changes' ||
      cursor.documentId !== documentId ||
      !validSequence(cursor.sequence) ||
      encodeConversationChangeCursor(cursor as ConversationChangeCursor) !==
        value
    )
      throw new Error();
    return cursor.sequence!;
  } catch {
    throw new HttpError(400, 'Cursor de mudanças de conversas inválido.');
  }
}

function encodeConversationChildCursor(cursor: ConversationChildCursor) {
  return cursorBase64(JSON.stringify(cursor));
}

function decodeConversationChildCursor(
  value: string,
  documentId: string,
  rootId: string,
  type: ConversationChildCursor['type'],
) {
  try {
    if (!validCursorText(value)) throw new Error();
    const cursor = JSON.parse(
      cursorText(value),
    ) as Partial<ConversationChildCursor>;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !==
        'documentId,rootId,sequence,type,v' ||
      cursor.v !== 1 ||
      cursor.type !== type ||
      cursor.documentId !== documentId ||
      cursor.rootId !== rootId ||
      !validSequence(cursor.sequence, 1) ||
      encodeConversationChildCursor(cursor as ConversationChildCursor) !== value
    )
      throw new Error();
    return cursor.sequence!;
  } catch {
    throw new HttpError(
      400,
      type === 'conversation-replies'
        ? 'Cursor de respostas inválido.'
        : 'Cursor de histórico inválido.',
    );
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
      .prepare(`SELECT d.id,d.owner_id,r.title,r.filename,r.markdown,d.is_test,d.created_at,
        r.id AS current_revision_id,r.ordinal AS revision_ordinal,
        r.author_id AS revision_author_id,r.created_at AS revision_created_at
      FROM documents d JOIN document_revisions r
        ON r.id=d.current_revision_id AND r.document_id=d.id
      WHERE d.id=? AND d.is_test=? AND
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
  async revision(id: string, revisionId: string) {
    await this.document(id);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        revisionId,
      )
    )
      throw new HttpError(400, 'Revisão inválida.');
    const revision = await this.db
      .prepare(
        `SELECT id,document_id,ordinal,author_id,title,filename,markdown,created_at
         FROM document_revisions WHERE id=? AND document_id=?`,
      )
      .bind(revisionId, id)
      .first<DocumentRevisionRow>();
    if (!revision) throw new HttpError(404, 'Revisão indisponível.');
    await this.document(id);
    return revision;
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
      .prepare(
        `SELECT d.owner_id,d.is_test,r.title,r.filename,r.markdown
         FROM documents d LEFT JOIN document_revisions r
           ON r.id=d.current_revision_id AND r.document_id=d.id
         WHERE d.id=?`,
      )
      .bind(id)
      .first<{
        owner_id: string;
        is_test: number;
        title: string | null;
        filename: string | null;
        markdown: string | null;
      }>();
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
      return this.document(id);
    }
    const limit = ownedDocumentLimit(this.quotaEnvironment);
    const createdAt = new Date().toISOString();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO documents (id,owner_id,title,filename,markdown,created_at,is_test,current_revision_id)
           SELECT ?,?,?,?,?,?,?,NULL WHERE
           NOT EXISTS(SELECT 1 FROM documents WHERE id=?) AND
           (SELECT count(*) FROM documents WHERE owner_id=? AND is_test=?)<?`,
        )
        .bind(
          id,
          authorId,
          title,
          filename,
          markdown,
          createdAt,
          isTest,
          id,
          authorId,
          isTest,
          limit,
        ),
      this.db
        .prepare(
          `INSERT INTO document_revisions
             (id,document_id,ordinal,author_id,title,filename,markdown,created_at)
           SELECT d.id,d.id,1,d.owner_id,d.title,d.filename,d.markdown,d.created_at
           FROM documents d WHERE d.id=? AND d.owner_id=? AND d.is_test=?
             AND d.title=? AND d.filename=? AND d.markdown=?
             AND NOT EXISTS(SELECT 1 FROM document_revisions r WHERE r.document_id=d.id)`,
        )
        .bind(id, authorId, isTest, title, filename, markdown),
      this.db
        .prepare(
          `UPDATE documents SET current_revision_id=? WHERE id=?
           AND current_revision_id IS NULL
           AND EXISTS(SELECT 1 FROM document_revisions r
             WHERE r.id=? AND r.document_id=documents.id AND r.ordinal=1)`,
        )
        .bind(id, id, id),
    ]);
    const document = await this.db
      .prepare(
        `SELECT d.owner_id,d.is_test,r.title,r.filename,r.markdown
         FROM documents d LEFT JOIN document_revisions r
           ON r.id=d.current_revision_id AND r.document_id=d.id
         WHERE d.id=?`,
      )
      .bind(id)
      .first<{
        owner_id: string;
        is_test: number;
        title: string | null;
        filename: string | null;
        markdown: string | null;
      }>();
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
    return this.document(id);
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
    // D1 accepts at most 100 bindings. document_id consumes one, so a root
    // lookup may contain at most 99 ids even when a page has 100 replies.
    const chunks = Array.from(
      { length: Math.ceil(rootIds.length / 99) },
      (_, index) => rootIds.slice(index * 99, (index + 1) * 99),
    );
    const pages = await Promise.all(
      chunks.map(async (ids) => {
        const placeholders = ids.map(() => '?').join(',');
        return (
          await this.db
            .prepare(
              `SELECT ${publicCommentFields} FROM comments c JOIN users u ON u.id=c.author_id
               WHERE c.document_id=? AND c.id IN (${placeholders})`,
            )
            .bind(id, ...ids)
            .all<CommentRow>()
        ).results;
      }),
    );
    const roots = new Map(pages.flat().map((root) => [root.id, root]));
    return rootIds.flatMap((rootId) => {
      const root = roots.get(rootId);
      return root ? [root] : [];
    });
  }

  private async conversationRoot(id: string, rootId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(rootId))
      throw new HttpError(400, 'Conversa inválida.');
    const root = await this.db
      .prepare(
        `SELECT id FROM comments
         WHERE document_id=? AND id=? AND COALESCE(root_id,id)=id`,
      )
      .bind(id, rootId)
      .first<{ id: string }>();
    if (!root) throw new HttpError(404, 'Conversa indisponível.');
    return root;
  }

  async conversationState(id: string, rootId: string) {
    await this.document(id);
    await this.conversationRoot(id, rootId);
    return this.db
      .prepare(
        `SELECT r.id AS root_id,COALESCE(e.state,'open') AS state,e.decision,
           e.decision_reason,COALESCE(e.version,0) AS version,
           (SELECT count(*) FROM comments reply
            WHERE reply.document_id=r.document_id
              AND COALESCE(reply.root_id,reply.id)=r.id
              AND reply.id<>r.id) AS reply_count
         FROM comments r LEFT JOIN conversation_events e ON e.sequence=(
           SELECT latest.sequence FROM conversation_events latest
           WHERE latest.document_id=r.document_id AND latest.root_id=r.id
           ORDER BY latest.version DESC LIMIT 1
         )
         WHERE r.document_id=? AND r.id=? AND COALESCE(r.root_id,r.id)=r.id`,
      )
      .bind(id, rootId)
      .first<{
        root_id: string;
        state: 'open' | 'closed';
        decision: 'follow' | 'refute' | 'defer' | null;
        decision_reason: string | null;
        version: number;
        reply_count: number;
      }>();
  }

  async conversations(
    id: string,
    query: ConversationPageQuery = {},
  ): Promise<ConversationPage> {
    await this.document(id);
    const filter = query.filter ?? 'all';
    if (!['all', 'open', 'unanswered', 'closed'].includes(filter))
      throw new HttpError(400, 'Filtro de conversas inválido.');
    const boundary = query.cursor
      ? decodeConversationCursor(query.cursor, id, filter)
      : null;
    // The watermark is captured before the snapshot so a concurrent write is
    // either represented in the snapshot or replayed by the unfiltered feed.
    const watermark =
      (await this.db
        .prepare(
          'SELECT COALESCE(max(sequence),0) AS sequence FROM conversation_changes WHERE document_id=?',
        )
        .bind(id)
        .first<{ sequence: number }>())?.sequence ?? 0;
    const filterSql =
      filter === 'open'
        ? "AND COALESCE(e.state,'open')='open'"
        : filter === 'closed'
          ? "AND COALESCE(e.state,'open')='closed'"
          : filter === 'unanswered'
            ? 'AND NOT EXISTS(SELECT 1 FROM comments reply WHERE reply.document_id=c.document_id AND COALESCE(reply.root_id,reply.id)=c.id AND reply.id<>c.id)'
            : '';
    const rootSelection = `FROM comments c JOIN users u ON u.id=c.author_id
       LEFT JOIN conversation_events e ON e.sequence=(
         SELECT latest.sequence FROM conversation_events latest
         WHERE latest.document_id=c.document_id AND latest.root_id=c.id
         ORDER BY latest.version DESC LIMIT 1
       )
       WHERE c.document_id=? AND COALESCE(c.root_id,c.id)=c.id
         ${boundary === null ? '' : 'AND c.sequence<?'}
         ${filterSql}
       ORDER BY c.sequence DESC LIMIT ?`;
    const rootBindings = [
      id,
      ...(boundary === null ? [] : [boundary]),
      conversationPageSize + 1,
    ];
    const replyBindings = [
      id,
      ...(boundary === null ? [] : [boundary]),
      conversationPageSize,
      id,
      conversationReplyPreviewSize + 1,
    ];
    // Both result sets share one D1 batch snapshot. A reply cannot appear in
    // the preview without also being reflected in reply_count.
    const [rootResult, replyResult] = await this.db.batch([
      this.db
        .prepare(
          `SELECT ${publicCommentFields},c.sequence AS transport_sequence,
             COALESCE(e.state,'open') AS state,e.decision,e.decision_reason,
             COALESCE(e.version,0) AS version,
             (SELECT count(*) FROM comments reply
              WHERE reply.document_id=c.document_id
                AND COALESCE(reply.root_id,reply.id)=c.id
                AND reply.id<>c.id) AS reply_count
           ${rootSelection}`,
        )
        .bind(...rootBindings),
      this.db
        .prepare(
          `WITH root_page AS (
             SELECT c.id ${rootSelection}
           ), ranked AS (
             SELECT ${publicCommentFields},c.sequence AS transport_sequence,
               ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.sequence DESC) AS rank
             FROM comments c JOIN users u ON u.id=c.author_id
             JOIN root_page roots ON roots.id=c.root_id
             WHERE c.document_id=? AND c.id<>c.root_id
           )
           SELECT * FROM ranked WHERE rank<=? ORDER BY transport_sequence DESC`,
        )
        .bind(...replyBindings),
    ]);
    const rows = rootResult.results as ConversationRootRow[];
    const page = rows.slice(0, conversationPageSize);
    const repliesByRoot = new Map<string, SequencedCommentRow[]>();
    for (const reply of replyResult.results as Array<
      SequencedCommentRow & { rank: number }
    >) {
      const entries = repliesByRoot.get(reply.root_id) ?? [];
      entries.push(reply);
      repliesByRoot.set(reply.root_id, entries);
    }
    const conversations = page.map((row) => {
      const {
        transport_sequence: _transportSequence,
        reply_count,
        decision_reason,
        state,
        decision,
        version,
        ...root
      } = row;
      const newest = repliesByRoot.get(row.id) ?? [];
      const preview = newest.slice(0, conversationReplyPreviewSize);
      return {
        root,
        replies: publicComments(preview),
        repliesCursor:
          newest.length > conversationReplyPreviewSize && preview.length > 0
            ? encodeConversationChildCursor({
                v: 1,
                type: 'conversation-replies',
                documentId: id,
                rootId: row.id,
                sequence: sequenceOf(preview.at(-1)),
              })
            : null,
        replyCount: Number(reply_count),
        state,
        decision,
        decisionReason: decision_reason,
        version: Number(version),
      } satisfies ConversationRow;
    });
    const last = page.at(-1);
    return {
      conversations,
      nextCursor:
        rows.length > conversationPageSize && last
          ? encodeConversationCursor({
              v: 1,
              type: 'conversations',
              direction: 'older',
              documentId: id,
              filter,
              sequence: sequenceOf(last),
            })
          : null,
      changeCursor: encodeConversationChangeCursor({
        v: 1,
        type: 'conversation-changes',
        documentId: id,
        sequence: Number(watermark),
      }),
    };
  }

  async conversationChanges(id: string, after: string) {
    await this.document(id);
    const boundary = decodeConversationChangeCursor(after, id);
    const rows = (
      await this.db
        .prepare(
          `SELECT sequence,root_id FROM conversation_changes
           WHERE document_id=? AND sequence>? ORDER BY sequence LIMIT ?`,
        )
        .bind(id, boundary, conversationChangePageSize + 1)
        .all<{ sequence: number; root_id: string }>()
    ).results;
    const page = rows.slice(0, conversationChangePageSize);
    const sequence = page.at(-1)?.sequence ?? boundary;
    return {
      rootIds: [...new Set(page.map((row) => row.root_id))],
      nextCursor: encodeConversationChangeCursor({
        v: 1,
        type: 'conversation-changes',
        documentId: id,
        sequence: Number(sequence),
      }),
      hasMore: rows.length > conversationChangePageSize,
    };
  }

  async conversationReplies(id: string, rootId: string, cursor?: string) {
    await this.document(id);
    await this.conversationRoot(id, rootId);
    const boundary = cursor
      ? decodeConversationChildCursor(
          cursor,
          id,
          rootId,
          'conversation-replies',
        )
      : null;
    const rows = (
      await this.db
        .prepare(
          `SELECT ${publicCommentFields},c.sequence AS transport_sequence
           FROM comments c JOIN users u ON u.id=c.author_id
           WHERE c.document_id=? AND c.root_id=? AND c.id<>c.root_id
             ${boundary === null ? '' : 'AND c.sequence<?'}
           ORDER BY c.sequence DESC LIMIT ?`,
        )
        .bind(
          id,
          rootId,
          ...(boundary === null ? [] : [boundary]),
          conversationReplyPageSize + 1,
        )
        .all<SequencedCommentRow>()
    ).results;
    const page = rows.slice(0, conversationReplyPageSize);
    return {
      replies: publicComments(page),
      nextCursor:
        rows.length > conversationReplyPageSize && page.length > 0
          ? encodeConversationChildCursor({
              v: 1,
              type: 'conversation-replies',
              documentId: id,
              rootId,
              sequence: sequenceOf(page.at(-1)),
            })
          : null,
    };
  }

  async conversationEvents(id: string, rootId: string, cursor?: string) {
    await this.document(id);
    await this.conversationRoot(id, rootId);
    const boundary = cursor
      ? decodeConversationChildCursor(
          cursor,
          id,
          rootId,
          'conversation-events',
        )
      : null;
    const rows = (
      await this.db
        .prepare(
          `SELECT e.id,e.document_id,e.root_id,e.actor_id,u.name AS actor_name,
             e.base_version,e.version,e.action,e.state,e.decision,
             e.decision_reason,e.reason,e.created_at,e.sequence AS transport_sequence
           FROM conversation_events e JOIN users u ON u.id=e.actor_id
           WHERE e.document_id=? AND e.root_id=?
             ${boundary === null ? '' : 'AND e.sequence<?'}
           ORDER BY e.sequence DESC LIMIT ?`,
        )
        .bind(
          id,
          rootId,
          ...(boundary === null ? [] : [boundary]),
          conversationEventPageSize + 1,
        )
        .all<SequencedConversationEventRow>()
    ).results;
    const page = rows.slice(0, conversationEventPageSize);
    return {
      events: page.map(({ transport_sequence: _sequence, document_id: _id, ...event }) => event),
      nextCursor:
        rows.length > conversationEventPageSize && page.length > 0
          ? encodeConversationChildCursor({
              v: 1,
              type: 'conversation-events',
              documentId: id,
              rootId,
              sequence: Number(page.at(-1)!.transport_sequence),
            })
          : null,
    };
  }

  async conversationEvent(id: string, rootId: string, eventId: string) {
    await this.document(id);
    await this.conversationRoot(id, rootId);
    if (!/^[0-9a-f-]{36}$/i.test(eventId))
      throw new HttpError(400, 'Identificador inválido.');
    return this.db
      .prepare(
        `SELECT e.id,e.root_id,e.actor_id,u.name AS actor_name,e.base_version,
           e.version,e.action,e.state,e.decision,e.decision_reason,e.reason,e.created_at
         FROM conversation_events e JOIN users u ON u.id=e.actor_id
         WHERE e.document_id=? AND e.root_id=? AND e.id=?`,
      )
      .bind(id, rootId, eventId)
      .first<ConversationEventRow>();
  }

  async addConversationEvent(
    id: string,
    rootId: string,
    input: Record<string, unknown>,
  ) {
    const document = await this.document(id, true);
    await this.conversationRoot(id, rootId);
    if (
      Object.keys(input).some(
        (key) => !['id', 'authorId', 'baseVersion', 'action', 'reason'].includes(key),
      )
    )
      throw new HttpError(400, 'Alteração de conversa inválida.');
    const eventId = requiredText(input.id, 'Identificador da alteração', 36);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId))
      throw new HttpError(400, 'Identificador da alteração inválido.');
    const actorId = requiredText(input.authorId, 'Autor da alteração', 128);
    if (actorId !== this.viewer.id)
      throw new HttpError(409, 'Esta alteração pertence a outra sessão.');
    const baseVersion = input.baseVersion;
    if (!validSequence(baseVersion))
      throw new HttpError(400, 'Versão-base da conversa inválida.');
    const action = input.action;
    if (
      typeof action !== 'string' ||
      !['close', 'reopen', 'follow', 'refute', 'defer'].includes(action)
    )
      throw new HttpError(400, 'Ação de conversa inválida.');
    const reason =
      input.reason === undefined || input.reason === null || input.reason === ''
        ? null
        : requiredText(input.reason, 'Motivo', 500);
    const existing = await this.db
      .prepare(
        `SELECT e.id,e.root_id,e.actor_id,u.name AS actor_name,e.base_version,
           e.version,e.action,e.state,e.decision,e.decision_reason,e.reason,
           e.created_at,e.document_id
         FROM conversation_events e JOIN users u ON u.id=e.actor_id WHERE e.id=?`,
      )
      .bind(eventId)
      .first<ConversationEventRow & { document_id: string }>();
    if (existing) {
      if (
        existing.document_id !== id ||
        existing.root_id !== rootId ||
        existing.actor_id !== actorId ||
        existing.base_version !== baseVersion ||
        existing.action !== action ||
        existing.reason !== reason
      )
        throw new HttpError(409, 'Esta alteração já foi usada em outra conversa ou com outro conteúdo.');
      const { document_id: _documentId, ...event } = existing;
      return { event, replayed: true };
    }
    const decision = ['follow', 'refute', 'defer'].includes(action)
      ? action
      : null;
    const now = new Date().toISOString();
    const insertion = await this.db
      .prepare(
        `INSERT INTO conversation_events (
           id,document_id,root_id,actor_id,base_version,version,action,state,
           decision,decision_reason,reason,created_at
         )
         SELECT ?,d.id,r.id,?,?,?+1,?,
           CASE WHEN ?='close' THEN 'closed' WHEN ?='reopen' THEN 'open'
             ELSE COALESCE(previous.state,'open') END,
           CASE WHEN ? IS NOT NULL THEN ? ELSE previous.decision END,
           CASE WHEN ? IS NOT NULL THEN ? ELSE previous.decision_reason END,
           ?,?
         FROM documents d JOIN comments r ON r.document_id=d.id
         LEFT JOIN conversation_events previous ON previous.sequence=(
           SELECT latest.sequence FROM conversation_events latest
           WHERE latest.document_id=d.id AND latest.root_id=r.id
           ORDER BY latest.version DESC LIMIT 1
         )
         WHERE d.id=? AND d.owner_id=? AND d.is_test=? AND r.id=?
           AND COALESCE(r.root_id,r.id)=r.id
           AND COALESCE(previous.version,0)=?`,
      )
      .bind(
        eventId,
        actorId,
        baseVersion,
        baseVersion,
        action,
        action,
        action,
        decision,
        decision,
        decision,
        reason,
        reason,
        now,
        id,
        actorId,
        document.is_test,
        rootId,
        baseVersion,
      )
      .run();
    const inserted = await this.conversationEvent(id, rootId, eventId);
    if (!inserted)
      throw new HttpError(
        409,
        'A conversa mudou desde a sua leitura. Seu motivo foi preservado para revisão.',
      );
    if (
      inserted.root_id !== rootId ||
      inserted.actor_id !== actorId ||
      inserted.base_version !== baseVersion ||
      inserted.action !== action ||
      inserted.reason !== reason
    )
      throw new HttpError(
        409,
        'Esta alteração já foi usada em outra conversa ou com outro conteúdo.',
      );
    return {
      event: inserted,
      replayed: Number(insertion.meta.changes ?? 0) === 0,
    };
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

  async commentContext(
    id: string,
    commentId: string,
  ): Promise<DirectedCommentContext> {
    await this.document(id);
    if (!/^[0-9a-f-]{36}$/i.test(commentId))
      throw new HttpError(400, 'Comentário inválido.');
    const rootIdSql = `SELECT COALESCE(target.root_id,target.id)
      FROM comments target WHERE target.document_id=? AND target.id=?`;
    const [targetResult, rootResult, stateResult, replyResult] =
      await this.db.batch([
        this.db
          .prepare(
            `SELECT ${publicCommentFields} FROM comments c JOIN users u ON u.id=c.author_id
             WHERE c.document_id=? AND c.id=?`,
          )
          .bind(id, commentId),
        this.db
          .prepare(
            `SELECT ${publicCommentFields} FROM comments c JOIN users u ON u.id=c.author_id
             WHERE c.document_id=? AND c.id=(${rootIdSql})
               AND COALESCE(c.root_id,c.id)=c.id`,
          )
          .bind(id, id, commentId),
        this.db
          .prepare(
            `SELECT r.id AS root_id,COALESCE(e.state,'open') AS state,e.decision,
               e.decision_reason,COALESCE(e.version,0) AS version,
               (SELECT count(*) FROM comments reply
                WHERE reply.document_id=r.document_id
                  AND COALESCE(reply.root_id,reply.id)=r.id
                  AND reply.id<>r.id) AS reply_count
             FROM comments r LEFT JOIN conversation_events e ON e.sequence=(
               SELECT latest.sequence FROM conversation_events latest
               WHERE latest.document_id=r.document_id AND latest.root_id=r.id
               ORDER BY latest.version DESC LIMIT 1
             )
             WHERE r.document_id=? AND r.id=(${rootIdSql})
               AND COALESCE(r.root_id,r.id)=r.id`,
          )
          .bind(id, id, commentId),
        this.db
          .prepare(
            `SELECT ${publicCommentFields},c.sequence AS transport_sequence
             FROM comments c JOIN users u ON u.id=c.author_id
             WHERE c.document_id=? AND c.root_id=(${rootIdSql})
               AND c.id<>c.root_id
             ORDER BY c.sequence DESC LIMIT ?`,
          )
          .bind(id, id, commentId, conversationReplyPageSize + 1),
      ]);
    const target = (targetResult.results as CommentRow[])[0];
    const root = (rootResult.results as CommentRow[])[0];
    const state = (
      stateResult.results as Array<{
        root_id: string;
        state: 'open' | 'closed';
        decision: 'follow' | 'refute' | 'defer' | null;
        decision_reason: string | null;
        version: number;
        reply_count: number;
      }>
    )[0];
    if (!target || !root || !state)
      throw new HttpError(404, 'Comentário indisponível.');
    const rows = replyResult.results as SequencedCommentRow[];
    const page = rows.slice(0, conversationReplyPageSize);
    return {
      target,
      conversation: {
        root,
        replies: publicComments(page),
        repliesCursor:
          rows.length > conversationReplyPageSize && page.length > 0
            ? encodeConversationChildCursor({
                v: 1,
                type: 'conversation-replies',
                documentId: id,
                rootId: root.id,
                sequence: sequenceOf(page.at(-1)),
              })
            : null,
        replyCount: Number(state.reply_count),
        state: state.state,
        decision: state.decision,
        decisionReason: state.decision_reason,
        version: Number(state.version),
      },
    };
  }

  async addComment(id: string, input: Record<string, unknown>) {
    await this.document(id);
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
        sourceStart < 0)
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
            'sourceRevisionId',
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
    const requestedSourceRevisionId =
      input.sourceRevisionId === undefined || input.sourceRevisionId === null
        ? null
        : requiredText(input.sourceRevisionId, 'Revisão de origem', 36);
    if (
      requestedSourceRevisionId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        requestedSourceRevisionId,
      )
    )
      throw new HttpError(400, 'Revisão de origem inválida.');
    const existing = await this.db
      .prepare(
        `SELECT ${publicCommentFields},c.document_id FROM comments c JOIN users u ON u.id=c.author_id WHERE c.id=?`,
      )
      .bind(commentId)
      .first<CommentRow & { document_id: string }>();
    if (existing) {
      const rootId = requestedRootId ?? commentId;
      if (
        existing.author_id !== authorId ||
        existing.document_id !== id ||
        existing.body !== body ||
        existing.quote !== quote ||
        existing.source_start !== sourceStart ||
        existing.root_id !== rootId ||
        (requestedSourceRevisionId !== null &&
          existing.source_revision_id !== requestedSourceRevisionId)
      )
        throw new HttpError(
          409,
          'Este comentário já foi enviado com outro conteúdo.',
        );
      const sourceRevision = await this.db
        .prepare(
          'SELECT markdown FROM document_revisions WHERE id=? AND document_id=?',
        )
        .bind(existing.source_revision_id, id)
        .first<{ markdown: string }>();
      if (!sourceRevision)
        throw new Error('Comment source revision is unavailable.');
      if (sourceStart !== null && sourceStart >= sourceRevision.markdown.length)
        throw new HttpError(400, 'Trecho inválido. Selecione novamente.');
      await this.document(id);
      return existing;
    }

    // A reply never carries a fresh anchor: the root owns the preserved context.
    let rootId = commentId;
    let sourceRevision: DocumentRevisionRow | null = null;
    let requireSingleRevision = false;
    if (requestedRootId) {
      const root = await this.db
        .prepare(
          `SELECT id,document_id,COALESCE(root_id,id) AS root_id,source_revision_id
           FROM comments WHERE id=? AND document_id=?`,
        )
        .bind(requestedRootId, id)
        .first<{
          id: string;
          document_id: string;
          root_id: string;
          source_revision_id: string | null;
        }>();
      if (!root || root.id !== root.root_id || !root.source_revision_id)
        throw new HttpError(404, 'Conversa indisponível.');
      if (quote !== '' || sourceStart !== null)
        throw new HttpError(
          400,
          'Uma resposta preserva o trecho e a origem da conversa raiz.',
        );
      if (
        requestedSourceRevisionId !== null &&
        requestedSourceRevisionId !== root.source_revision_id
      )
        throw new HttpError(
          409,
          'A resposta deve preservar a revisão de origem da conversa.',
        );
      rootId = root.id;
      sourceRevision = await this.db
        .prepare(
          `SELECT id,document_id,ordinal,author_id,title,filename,markdown,created_at
           FROM document_revisions WHERE id=? AND document_id=?`,
        )
        .bind(root.source_revision_id, id)
        .first<DocumentRevisionRow>();
    } else if (requestedSourceRevisionId) {
      sourceRevision = await this.db
        .prepare(
          `SELECT id,document_id,ordinal,author_id,title,filename,markdown,created_at
           FROM document_revisions WHERE id=? AND document_id=?`,
        )
        .bind(requestedSourceRevisionId, id)
        .first<DocumentRevisionRow>();
    } else {
      const revisions = (
        await this.db
          .prepare(
            `SELECT id,document_id,ordinal,author_id,title,filename,markdown,created_at
             FROM document_revisions WHERE document_id=? ORDER BY ordinal LIMIT 2`,
          )
          .bind(id)
          .all<DocumentRevisionRow>()
      ).results;
      if (revisions.length !== 1)
        throw new HttpError(
          409,
          'Informe a revisão exibida antes de enviar este comentário.',
        );
      sourceRevision = revisions[0];
      requireSingleRevision = true;
    }
    if (!sourceRevision) throw new HttpError(404, 'Revisão indisponível.');
    if (sourceStart !== null && sourceStart >= sourceRevision.markdown.length)
      throw new HttpError(400, 'Trecho inválido. Selecione novamente.');

    const limit = commentLimit(this.quotaEnvironment);
    await this.db
      .prepare(
        `INSERT INTO comments (id,document_id,author_id,body,quote,source_start,source_revision_id,root_id,created_at)
         SELECT ?,?,?,?,?,?,?,?,? WHERE
         NOT EXISTS(SELECT 1 FROM comments WHERE id=?) AND
         (SELECT count(*) FROM comments WHERE document_id=?)<? AND
         EXISTS(SELECT 1 FROM document_revisions r WHERE r.id=? AND r.document_id=?) AND
         (?=0 OR (SELECT count(*) FROM document_revisions WHERE document_id=?)=1) AND
         (? IS NULL OR EXISTS(SELECT 1 FROM comments root
           WHERE root.id=? AND root.document_id=? AND COALESCE(root.root_id,root.id)=root.id
             AND root.source_revision_id=?)) AND
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
        sourceRevision.id,
        rootId,
        new Date().toISOString(),
        commentId,
        id,
        limit,
        sourceRevision.id,
        id,
        requireSingleRevision ? 1 : 0,
        id,
        requestedRootId,
        requestedRootId,
        id,
        sourceRevision.id,
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
    if (!comment && requireSingleRevision) {
      const revisionCount = await this.db
        .prepare(
          'SELECT count(*) AS count FROM document_revisions WHERE document_id=?',
        )
        .bind(id)
        .first<{ count: number }>();
      if ((revisionCount?.count ?? 0) !== 1)
        throw new HttpError(
          409,
          'Informe a revisão exibida antes de enviar este comentário.',
        );
    }
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
      comment.root_id !== rootId ||
      comment.source_revision_id !== sourceRevision.id
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
    const revokedAt = Math.floor(Date.now() / 1000);
    await this.db.batch([
      this.db
        .prepare('DELETE FROM shares WHERE document_id=? AND email=?')
        .bind(id, normalizedEmail),
      this.db
        .prepare('DELETE FROM magic_links WHERE document_id=? AND email=?')
        .bind(id, normalizedEmail),
      this.db
        .prepare(
          `UPDATE notification_deliveries SET status='suppressed',
             lease_token=NULL,lease_expires_at=NULL,
             last_error_code='access_revoked',last_error_at=?
           WHERE recipient_email=?
             AND status IN ('pending','leased','blocked')
             AND event_id IN (
               SELECT id FROM notification_events WHERE document_id=?
             )`,
        )
        .bind(revokedAt, normalizedEmail, id),
    ]);
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
