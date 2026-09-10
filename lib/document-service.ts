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
  body: string;
  quote: string;
  source_start: number | null;
  created_at: string;
  author_id: string;
  author_name: string;
};
export type ShareRow = { email: string; name: string; created_at: string };
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
export class DocumentService {
  constructor(
    private db: D1Database,
    public viewer: Viewer,
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
  async list() {
    return (
      await this.db
        .prepare(`SELECT d.id,d.title,d.filename,d.owner_id,d.created_at,u.name AS owner_name,
      (SELECT count(*) FROM comments c WHERE c.document_id=d.id) AS comment_count
      FROM documents d JOIN users u ON u.id=d.owner_id
      WHERE d.is_test=? AND (d.owner_id=? OR EXISTS(SELECT 1 FROM shares s WHERE s.document_id=d.id AND s.email=?))
      ORDER BY d.created_at DESC`)
        .bind(
          this.viewer.isTest ? 1 : 0,
          this.viewer.id,
          this.viewer.isTest ? '' : this.viewer.email,
        )
        .all()
    ).results;
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
    const { markdown, filename, title } = documentInput(input);
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        'INSERT INTO documents (id,owner_id,title,filename,markdown,created_at,is_test) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        this.viewer.id,
        title,
        filename,
        markdown,
        new Date().toISOString(),
        this.viewer.isTest ? 1 : 0,
      )
      .run();
    return this.document(id);
  }
  async comments(id: string) {
    await this.document(id);
    return (
      await this.db
        .prepare(
          `SELECT c.*,u.name AS author_name FROM comments c JOIN users u ON u.id=c.author_id WHERE c.document_id=? ORDER BY c.created_at,c.id`,
        )
        .bind(id)
        .all<CommentRow>()
    ).results;
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
    await this.db
      .prepare(
        'INSERT INTO comments (id,document_id,author_id,body,quote,source_start,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(
        commentId,
        id,
        authorId,
        body,
        quote,
        sourceStart,
        new Date().toISOString(),
      )
      .run();
    // Access can be revoked while the write is in flight. Do not disclose the
    // persisted row in the response unless this request still has access.
    await this.document(id);
    const comment = await this.db
      .prepare(
        'SELECT c.*,u.name AS author_name FROM comments c JOIN users u ON u.id=c.author_id WHERE c.id=?',
      )
      .bind(commentId)
      .first<CommentRow & { document_id: string }>();
    if (!comment) throw new Error('Inserted comment could not be read back.');
    if (
      comment.author_id !== authorId ||
      comment.document_id !== id ||
      comment.body !== body ||
      comment.quote !== quote ||
      comment.source_start !== sourceStart
    )
      throw new HttpError(
        409,
        'Este comentário já foi enviado com outro conteúdo.',
      );
    return comment;
  }
  async shares(id: string) {
    await this.document(id, true);
    return (
      await this.db
        .prepare(
          'SELECT email,name,created_at FROM shares WHERE document_id=? ORDER BY created_at',
        )
        .bind(id)
        .all<ShareRow>()
    ).results;
  }
  async share(id: string, input: Record<string, unknown>) {
    await this.document(id, true);
    const email = normalizeEmail(requiredText(input.email, 'E-mail', 254));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new HttpError(400, 'Informe um e-mail válido.');
    if (email === this.viewer.email) return this.shares(id);
    const name =
      typeof input.name === 'string' && input.name.trim()
        ? requiredText(input.name, 'Nome', 120)
        : email;
    await this.db
      .prepare(
        'INSERT INTO shares (document_id,email,name,created_at) VALUES (?,?,?,?) ON CONFLICT(document_id,email) DO NOTHING',
      )
      .bind(id, email, name, new Date().toISOString())
      .run();
    return this.shares(id);
  }
  async revoke(id: string, email: string) {
    await this.document(id, true);
    await this.db
      .prepare('DELETE FROM shares WHERE document_id=? AND email=?')
      .bind(id, normalizeEmail(email))
      .run();
    await this.db
      .prepare('DELETE FROM magic_links WHERE document_id=? AND email=?')
      .bind(id, normalizeEmail(email))
      .run();
    return this.shares(id);
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
