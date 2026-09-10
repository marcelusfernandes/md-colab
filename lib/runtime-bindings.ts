import { env } from 'cloudflare:workers';

export function getRuntimeBindings(): Cloudflare.Env {
  return {
    DB: env.DB,
    ACCESS_MODE: env.ACCESS_MODE ?? process.env.ACCESS_MODE,
    APP_ORIGIN: env.APP_ORIGIN ?? process.env.APP_ORIGIN,
    APP_AUTHOR_EMAILS: env.APP_AUTHOR_EMAILS ?? process.env.APP_AUTHOR_EMAILS,
    APP_OWNER_EMAIL: env.APP_OWNER_EMAIL ?? process.env.APP_OWNER_EMAIL,
    APP_OWNER_NAME: env.APP_OWNER_NAME ?? process.env.APP_OWNER_NAME,
    RESEND_API_KEY: env.RESEND_API_KEY ?? process.env.RESEND_API_KEY,
    MAIL_FROM: env.MAIL_FROM ?? process.env.MAIL_FROM,
    MAX_OWNED_DOCUMENTS:
      env.MAX_OWNED_DOCUMENTS ?? process.env.MAX_OWNED_DOCUMENTS,
    MAX_COMMENTS_PER_DOCUMENT:
      env.MAX_COMMENTS_PER_DOCUMENT ?? process.env.MAX_COMMENTS_PER_DOCUMENT,
    MAX_ACTIVE_SHARES_PER_DOCUMENT:
      env.MAX_ACTIVE_SHARES_PER_DOCUMENT ??
      process.env.MAX_ACTIVE_SHARES_PER_DOCUMENT,
  };
}
