import { HttpError, normalizeEmail, type Viewer } from './document-service.ts';
import type { Mailer } from './mailer.ts';

export const LINK_SECONDS = 15 * 60;
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const REQUEST_MESSAGE =
  'Se este e-mail tiver acesso, você receberá um link em instantes. Confira também a pasta de spam.';
export type AuthConfig = {
  origin: string;
  ownerEmail: string;
  ownerName?: string;
  testMode?: boolean;
};

export function validEmail(value: unknown) {
  if (typeof value !== 'string')
    throw new HttpError(400, 'Informe um e-mail válido.');
  const email = normalizeEmail(value);
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
    throw new HttpError(400, 'Informe um e-mail válido.');
  return email;
}

export function authConfig(values: {
  ACCESS_MODE?: string;
  APP_ORIGIN?: string;
  APP_OWNER_EMAIL?: string;
  APP_OWNER_NAME?: string;
}): AuthConfig {
  try {
    const url = new URL(values.APP_ORIGIN ?? '');
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname)
        ))
    )
      throw new Error();
    return {
      origin: url.origin,
      ownerEmail: validEmail(values.APP_OWNER_EMAIL),
      ownerName: values.APP_OWNER_NAME,
      testMode: values.ACCESS_MODE === 'test',
    };
  } catch {
    throw new HttpError(503, 'O acesso por e-mail ainda não foi configurado.');
  }
}

export async function hashToken(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export class AuthService {
  constructor(
    private db: D1Database,
    public config: AuthConfig,
    private mailer: Mailer,
    private now = () => Math.floor(Date.now() / 1000),
  ) {}

  canCreate(viewer: Viewer) {
    return viewer.isTest
      ? !!this.config.testMode
      : viewer.email === this.config.ownerEmail;
  }

  async enterTest(input: Record<string, unknown>, request: Request) {
    if (!this.config.testMode)
      throw new HttpError(404, 'Acesso de teste indisponível.');
    const email = validEmail(input.email);
    const documentId = input.documentId ?? null;
    if (documentId !== null) {
      if (
        typeof documentId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(documentId) ||
        !(await this.db
          .prepare('SELECT id FROM documents WHERE id=? AND is_test=1')
          .bind(documentId)
          .first())
      )
        throw new HttpError(404, 'Documento de teste indisponível.');
    }
    const existing = await this.viewer(request);
    const id = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      // A typed email is only a label. It never selects a real or existing identity.
      await this.db
        .prepare('INSERT INTO users(id,email,name,test_email) VALUES(?,?,?,?)')
        .bind(id, 'test.' + id + '@sessions.invalid', email, email)
        .run();
    }
    const session = randomToken();
    await this.db
      .prepare(
        'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',
      )
      .bind(await hashToken(session), id, this.now() + SESSION_SECONDS)
      .run();
    await this.logout(request);
    return { session, redirect: documentId ? '/d/' + documentId : '/' };
  }
  assertMailConfigured() {
    this.mailer.assertConfigured();
  }

  private async allowed(email: string, documentId: string | null) {
    if (documentId) {
      return !!(await this.db
        .prepare(`SELECT d.id FROM documents d JOIN users u ON u.id=d.owner_id
        WHERE d.id=? AND (u.email=? OR EXISTS(SELECT 1 FROM shares s WHERE s.document_id=d.id AND s.email=?))`)
        .bind(documentId, email, email)
        .first());
    }
    if (email === this.config.ownerEmail) return true;
    return !!(await this.db
      .prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM shares WHERE email=?)
      OR EXISTS(SELECT 1 FROM documents d JOIN users u ON u.id=d.owner_id WHERE u.email=?)`)
      .bind(email, email)
      .first());
  }

  async limit(scope: string, key: string, maximum: number, seconds: number) {
    const now = this.now();
    const result = await this.db
      .prepare(`INSERT INTO auth_limits(scope,key_hash,expires_at,count) VALUES(?,?,?,1)
      ON CONFLICT(scope,key_hash) DO UPDATE SET
      count=CASE WHEN auth_limits.expires_at<=? THEN 1 ELSE auth_limits.count+1 END,
      expires_at=CASE WHEN auth_limits.expires_at<=? THEN excluded.expires_at ELSE auth_limits.expires_at END
      WHERE auth_limits.expires_at<=? OR auth_limits.count<? RETURNING count`)
      .bind(scope, await hashToken(key), now + seconds, now, now, now, maximum)
      .first();
    if (!result)
      throw new HttpError(
        429,
        'Muitas tentativas. Aguarde alguns minutos antes de solicitar outro link.',
      );
  }

  async requestLink(input: Record<string, unknown>, ip: string) {
    const email = validEmail(input.email);
    const documentId =
      input.documentId === undefined || input.documentId === null
        ? null
        : input.documentId;
    if (
      documentId !== null &&
      (typeof documentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(documentId))
    )
      throw new HttpError(400, 'Solicitação inválida.');
    this.assertMailConfigured();
    await this.limit('request-ip', ip, 30, LINK_SECONDS);
    await this.limit('request-email', email, 5, LINK_SECONDS);
    if (await this.allowed(email, documentId)) {
      // A provider failure must not reveal which addresses have access.
      // Authenticated invitations report failure to the owner separately.
      try {
        await this.issue(email, documentId, false);
      } catch {
        /* Generic response prevents address enumeration. */
      }
    }
    return { message: REQUEST_MESSAGE };
  }

  async invite(email: string, documentId: string, actorId: string) {
    this.assertMailConfigured();
    await this.limit('invite-owner', actorId, 30, LINK_SECONDS);
    await this.limit('invite-email', email, 5, LINK_SECONDS);
    if (!(await this.allowed(email, documentId)))
      throw new HttpError(404, 'Acesso não encontrado.');
    await this.issue(email, documentId, true);
  }

  private async issue(
    email: string,
    documentId: string | null,
    invitation: boolean,
  ) {
    const now = this.now();
    // Expired authentication material is never needed for document history.
    await this.db.batch([
      this.db.prepare('DELETE FROM magic_links WHERE expires_at<=?').bind(now),
      this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),
      this.db.prepare('DELETE FROM auth_limits WHERE expires_at<=?').bind(now),
    ]);
    const token = randomToken();
    const hash = await hashToken(token);
    await this.db
      .prepare(
        'INSERT INTO magic_links(token_hash,email,document_id,expires_at,used_at) VALUES(?,?,?,?,NULL)',
      )
      .bind(hash, email, documentId, now + LINK_SECONDS)
      .run();
    try {
      // Fragment keeps the token out of HTTP access logs and referrer headers.
      await this.mailer.send({
        to: email,
        url: this.config.origin + '/access#token=' + token,
        invitation,
        id: hash,
      });
    } catch (error) {
      await this.db
        .prepare('DELETE FROM magic_links WHERE token_hash=?')
        .bind(hash)
        .run();
      throw error;
    }
  }

  async redeem(value: unknown) {
    const invalid = () =>
      new HttpError(
        401,
        'Este link expirou, já foi usado ou o acesso foi removido. Solicite um novo link.',
      );
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
      throw invalid();
    const now = this.now();
    // Consume and authorize in one atomic statement, including current grants.
    const link = await this.db
      .prepare(`UPDATE magic_links SET used_at=?
      WHERE token_hash=? AND used_at IS NULL AND expires_at>? AND (
        (document_id IS NULL AND (email=? OR EXISTS(SELECT 1 FROM shares s WHERE s.email=magic_links.email)
          OR EXISTS(SELECT 1 FROM documents d JOIN users u ON u.id=d.owner_id WHERE u.email=magic_links.email)))
        OR EXISTS(SELECT 1 FROM documents d JOIN users u ON u.id=d.owner_id WHERE d.id=magic_links.document_id
          AND (u.email=magic_links.email OR EXISTS(SELECT 1 FROM shares s WHERE s.document_id=d.id AND s.email=magic_links.email)))
      ) RETURNING email,document_id`)
      .bind(now, await hashToken(value), now, this.config.ownerEmail)
      .first<{ email: string; document_id: string | null }>();
    if (!link) throw invalid();
    const invited = await this.db
      .prepare(
        'SELECT name FROM shares WHERE email=? ORDER BY created_at LIMIT 1',
      )
      .bind(link.email)
      .first<{ name: string }>();
    const name =
      link.email === this.config.ownerEmail
        ? this.config.ownerName || link.email
        : invited?.name || link.email;
    await this.db
      .prepare(
        'INSERT INTO users(id,email,name) VALUES(?,?,?) ON CONFLICT(email) DO NOTHING',
      )
      .bind(crypto.randomUUID(), link.email, name)
      .run();
    const viewer = await this.db
      .prepare('SELECT id,email,name FROM users WHERE email=?')
      .bind(link.email)
      .first<Viewer>();
    if (!viewer)
      throw new HttpError(
        500,
        'Não foi possível entrar. Solicite um novo link.',
      );
    const session = randomToken();
    await this.db
      .prepare(
        'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',
      )
      .bind(await hashToken(session), viewer.id, now + SESSION_SECONDS)
      .run();
    return {
      viewer,
      session,
      redirect: link.document_id ? '/d/' + link.document_id : '/',
    };
  }

  private cookieName() {
    return this.config.origin.startsWith('https:')
      ? '__Host-md_session'
      : 'md_session';
  }
  private tokenFrom(request: Request) {
    const token = request.headers
      .get('cookie')
      ?.split(';')
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(this.cookieName() + '='))
      ?.slice(this.cookieName().length + 1);
    return token && /^[0-9a-f]{64}$/.test(token) ? token : null;
  }
  cookie(session: string, clear = false) {
    return `${this.cookieName()}=${clear ? '' : session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_SECONDS}${this.config.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  async viewer(request: Request) {
    const token = this.tokenFrom(request);
    if (!token) return null;
    const user = await this.db
      .prepare(
        `SELECT u.id,u.email,u.name,u.test_email FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.expires_at>? AND (u.test_email IS NOT NULL)=?`,
      )
      .bind(await hashToken(token), this.now(), this.config.testMode ? 1 : 0)
      .first<Viewer & { test_email: string | null }>();
    if (!user) return null;
    return {
      id: user.id,
      email: user.test_email ?? user.email,
      name: user.name,
      isTest: user.test_email !== null,
    };
  }
  async logout(request: Request) {
    const token = this.tokenFrom(request);
    if (token)
      await this.db
        .prepare('DELETE FROM sessions WHERE token_hash=?')
        .bind(await hashToken(token))
        .run();
  }
}
