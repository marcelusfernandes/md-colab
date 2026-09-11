import { hashToken, type AuthConfig } from './auth-service.ts';
import {
  documentInput,
  HttpError,
  normalizeEmail,
  requiredText,
  type Viewer,
} from './document-service.ts';
import {
  ownedDocumentLimit,
  quotaExceeded,
  type WriteQuotaEnvironment,
} from './write-quotas.ts';

export const PUBLISHING_TOKEN_SECONDS = 90 * 24 * 60 * 60;
export const MAX_ACTIVE_PUBLISHING_TOKENS = 10;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const TOKEN_PREFIX = 'mdp_';

export type PublishingTokenScope = 'publish' | 'plan_read' | 'plan_revise';

export type PublishingTokenRow = {
  id: string;
  name: string;
  scope: PublishingTokenScope;
  document_id: string | null;
  document_title: string | null;
  created_at: string;
  expires_at: number;
  revoked_at: number | null;
};

export type AuthenticatedToken = {
  credentialId: string;
  tokenHash: string;
  viewer: Viewer;
  scope: PublishingTokenScope;
  documentId: string | null;
};

type PublicationRow = {
  id: string;
  document_id: string;
  payload_digest: string;
};

function randomSecret() {
  return (
    TOKEN_PREFIX +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
  );
}

function validIdempotencyKey(value: string | null) {
  if (
    !value ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    value.trim() !== value ||
    !/^[\x21-\x7e]+$/.test(value)
  )
    throw new HttpError(
      400,
      'Informe Idempotency-Key com até 128 caracteres visíveis.',
    );
  return value;
}

function isIdempotencyConflict(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('publications_author_idempotency') ||
    /UNIQUE constraint failed: publications\.author_id, publications\.idempotency_key_hash/.test(
      message,
    )
  );
}

export class PublicationService {
  constructor(
    private db: D1Database,
    private config: AuthConfig,
    private now = () => Math.floor(Date.now() / 1000),
    private quotaEnvironment: WriteQuotaEnvironment = {},
  ) {}

  async createCredential(viewer: Viewer, input: Record<string, unknown>) {
    if (viewer.isTest)
      throw new HttpError(404, 'Credenciais de publicação indisponíveis.');
    const keys = Object.keys(input).sort().join(',');
    const requestedScope = input.scope;
    const scope: PublishingTokenScope =
      keys === 'name'
        ? 'publish'
        : keys === 'documentId,name,scope' &&
            (requestedScope === 'plan_read' || requestedScope === 'plan_revise')
          ? requestedScope
          : (() => {
              throw new HttpError(400, 'Finalidade da credencial inválida.');
            })();
    const name = requiredText(input.name, 'Nome da credencial', 80);
    const documentId =
      scope !== 'publish'
        ? requiredText(input.documentId, 'Plano da credencial', 36)
        : null;
    if (documentId !== null && !/^[0-9a-f-]{36}$/i.test(documentId))
      throw new HttpError(400, 'Plano da credencial inválido.');
    const id = crypto.randomUUID();
    const token = randomSecret();
    const now = this.now();
    const createdAt = new Date(now * 1000).toISOString();
    const expiresAt = now + PUBLISHING_TOKEN_SECONDS;
    const credential = await this.db
      .prepare(`INSERT INTO publishing_tokens(
        id,user_id,name,token_hash,scope,document_id,created_at,expires_at,revoked_at
      ) SELECT ?,?,?,?,?,?,?,?,NULL WHERE (
        SELECT count(*) FROM publishing_tokens
        WHERE user_id=? AND revoked_at IS NULL AND expires_at>?
      )<? AND (?='publish' OR EXISTS(
        SELECT 1 FROM documents
        WHERE id=? AND owner_id=? AND is_test=0
      )) RETURNING id,name,scope,document_id,
        (SELECT title FROM documents WHERE id=document_id) AS document_title,
        created_at,expires_at,revoked_at`)
      .bind(
        id,
        viewer.id,
        name,
        await hashToken(token),
        scope,
        documentId,
        createdAt,
        expiresAt,
        viewer.id,
        now,
        MAX_ACTIVE_PUBLISHING_TOKENS,
        scope,
        documentId,
        viewer.id,
      )
      .first<PublishingTokenRow>();
    if (!credential) {
      if (scope !== 'publish') {
        const owned = await this.db
          .prepare(
            'SELECT 1 AS found FROM documents WHERE id=? AND owner_id=? AND is_test=0',
          )
          .bind(documentId, viewer.id)
          .first<{ found: number }>();
        if (!owned)
          throw new HttpError(404, 'Plano indisponível para esta credencial.');
      }
      throw new HttpError(
        409,
        `Revogue uma credencial antes de criar outra. O limite é ${MAX_ACTIVE_PUBLISHING_TOKENS}.`,
      );
    }
    return { token, credential };
  }

  async credentials(viewer: Viewer) {
    if (viewer.isTest)
      throw new HttpError(404, 'Credenciais de publicação indisponíveis.');
    const now = this.now();
    return (
      await this.db
        .prepare(`SELECT p.id,p.name,p.scope,p.document_id,d.title AS document_title,
          p.created_at,p.expires_at,p.revoked_at
        FROM publishing_tokens p LEFT JOIN documents d ON d.id=p.document_id
        WHERE p.user_id=?
        ORDER BY CASE WHEN revoked_at IS NULL AND expires_at>? THEN 0 ELSE 1 END,
        p.created_at DESC,p.id DESC LIMIT 100`)
        .bind(viewer.id, now)
        .all<PublishingTokenRow>()
    ).results;
  }

  async revokeCredential(viewer: Viewer, id: string) {
    if (viewer.isTest)
      throw new HttpError(404, 'Credenciais de publicação indisponíveis.');
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new HttpError(404, 'Credencial não encontrada.');
    const now = this.now();
    const credential = await this.db
      .prepare(`UPDATE publishing_tokens SET revoked_at=COALESCE(revoked_at,?)
      WHERE id=? AND user_id=? RETURNING id,name,scope,document_id,
        (SELECT title FROM documents WHERE id=document_id) AS document_title,
        created_at,expires_at,revoked_at`)
      .bind(now, id, viewer.id)
      .first<PublishingTokenRow>();
    if (!credential) throw new HttpError(404, 'Credencial não encontrada.');
    return credential;
  }

  async authenticate(
    request: Request,
    expectedScope:
      | PublishingTokenScope
      | readonly PublishingTokenScope[] = 'publish',
  ): Promise<AuthenticatedToken> {
    const authorization = request.headers.get('authorization');
    const match = authorization?.match(/^Bearer (mdp_[0-9a-f]{64})$/);
    if (!match)
      throw new HttpError(401, 'Credencial de publicação inválida ou ausente.');
    const now = this.now();
    const tokenHash = await hashToken(match[1]);
    const expectedScopes = Array.isArray(expectedScope)
      ? expectedScope
      : [expectedScope];
    if (expectedScopes.length === 0)
      throw new HttpError(401, 'Credencial de publicação inválida ou ausente.');
    const scopePlaceholders = expectedScopes.map(() => '?').join(',');
    const row = await this.db
      .prepare(`SELECT p.id AS credential_id,p.scope,p.document_id,
        u.id,u.email,u.name,u.test_email
      FROM publishing_tokens p JOIN users u ON u.id=p.user_id
      LEFT JOIN documents d ON d.id=p.document_id
      WHERE p.token_hash=? AND p.revoked_at IS NULL AND p.expires_at>?
      AND u.test_email IS NULL AND p.scope IN (${scopePlaceholders})
      AND ((p.scope='publish' AND p.document_id IS NULL) OR
        (p.scope IN ('plan_read','plan_revise') AND d.id=p.document_id
          AND d.owner_id=p.user_id AND d.is_test=0))`)
      .bind(tokenHash, now, ...expectedScopes)
      .first<{
        credential_id: string;
        scope: PublishingTokenScope;
        document_id: string | null;
        id: string;
        email: string;
        name: string;
        test_email: string | null;
      }>();
    if (!row)
      throw new HttpError(401, 'Credencial de publicação inválida ou ausente.');
    return {
      credentialId: row.credential_id,
      tokenHash,
      scope: row.scope,
      documentId: row.document_id,
      viewer: {
        id: row.id,
        email: normalizeEmail(row.email),
        name: row.name,
      },
    };
  }

  private async previous(authorId: string, keyHash: string) {
    return this.db
      .prepare(`SELECT id,document_id,payload_digest FROM publications
      WHERE author_id=? AND idempotency_key_hash=?`)
      .bind(authorId, keyHash)
      .first<PublicationRow>();
  }

  private result(row: PublicationRow) {
    return {
      documentId: row.document_id,
      publicationId: row.id,
      url: this.config.origin + '/d/' + row.document_id,
    };
  }

  async publish(
    viewer: Viewer,
    credentialId: string,
    input: Record<string, unknown>,
    idempotencyHeader: string | null,
  ) {
    const key = validIdempotencyKey(idempotencyHeader);
    const parsed = documentInput(input, true);
    const keyHash = await hashToken(key);
    const payloadDigest = await hashToken(
      JSON.stringify([parsed.markdown, parsed.filename, parsed.requestedTitle]),
    );
    const previous = await this.previous(viewer.id, keyHash);
    if (previous) {
      if (previous.payload_digest !== payloadDigest)
        throw new HttpError(
          409,
          'Idempotency-Key já foi usada com outro conteúdo.',
        );
      return this.result(previous);
    }
    const limit = ownedDocumentLimit(this.quotaEnvironment);

    const documentId = crypto.randomUUID();
    const publicationId = crypto.randomUUID();
    const createdAt = new Date(this.now() * 1000).toISOString();
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO documents(id,owner_id,title,filename,markdown,created_at,is_test,current_revision_id)
             SELECT ?,?,?,?,?,?,0,NULL WHERE
             (SELECT count(*) FROM documents WHERE owner_id=? AND is_test=0)<?`,
          )
          .bind(
            documentId,
            viewer.id,
            parsed.title,
            parsed.filename,
            parsed.markdown,
            createdAt,
            viewer.id,
            limit,
          ),
        this.db
          .prepare(
            `INSERT INTO document_revisions
               (id,document_id,ordinal,author_id,title,filename,markdown,created_at)
             SELECT d.id,d.id,1,d.owner_id,d.title,d.filename,d.markdown,d.created_at
             FROM documents d WHERE d.id=? AND d.owner_id=? AND d.is_test=0`,
          )
          .bind(documentId, viewer.id),
        this.db
          .prepare(
            `UPDATE documents SET current_revision_id=? WHERE id=?
             AND current_revision_id IS NULL
             AND EXISTS(SELECT 1 FROM document_revisions r
               WHERE r.id=? AND r.document_id=documents.id AND r.ordinal=1)`,
          )
          .bind(documentId, documentId, documentId),
        this.db
          .prepare(`INSERT INTO publications(
            id,document_id,author_id,publishing_token_id,idempotency_key_hash,payload_digest,created_at
          ) SELECT ?,?,?,?,?,?,? WHERE EXISTS(
            SELECT 1 FROM documents WHERE id=? AND owner_id=? AND is_test=0
              AND current_revision_id=?
          )`)
          .bind(
            publicationId,
            documentId,
            viewer.id,
            credentialId,
            keyHash,
            payloadDigest,
            createdAt,
            documentId,
            viewer.id,
            documentId,
          ),
      ]);
      const persisted = await this.previous(viewer.id, keyHash);
      if (persisted) {
        if (persisted.payload_digest !== payloadDigest)
          throw new HttpError(
            409,
            'Idempotency-Key já foi usada com outro conteúdo.',
          );
        return this.result(persisted);
      }
      const count = await this.db
        .prepare(
          'SELECT count(*) AS count FROM documents WHERE owner_id=? AND is_test=0',
        )
        .bind(viewer.id)
        .first<{ count: number }>();
      if ((count?.count ?? 0) >= limit)
        throw quotaExceeded(
          'Você atingiu o limite total de planos próprios. Peça ao operador para ampliar a configuração.',
        );
      throw new Error('Publication batch completed without a receipt.');
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
      const winner = await this.previous(viewer.id, keyHash);
      if (!winner) throw error;
      if (winner.payload_digest !== payloadDigest)
        throw new HttpError(
          409,
          'Idempotency-Key já foi usada com outro conteúdo.',
        );
      return this.result(winner);
    }
  }
}
