import { openPersistentD1 } from './node-d1.ts';

let database: D1Database | undefined;

export function getRuntimeBindings(): Cloudflare.Env {
  database ??= openPersistentD1(
    process.env.MD_COLAB_DB_PATH ?? '/data/md-colab.sqlite',
  ).db;

  return {
    DB: database,
    ACCESS_MODE: process.env.ACCESS_MODE,
    APP_ORIGIN: process.env.APP_ORIGIN,
    APP_AUTHOR_MODE: process.env.APP_AUTHOR_MODE,
    APP_AUTHOR_EMAILS: process.env.APP_AUTHOR_EMAILS,
    APP_OWNER_EMAIL: process.env.APP_OWNER_EMAIL,
    APP_OWNER_NAME: process.env.APP_OWNER_NAME,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    MAIL_FROM: process.env.MAIL_FROM,
    NOTIFICATION_DRAIN_LIMIT: process.env.NOTIFICATION_DRAIN_LIMIT,
    NOTIFICATION_DRAIN_INTERVAL_MS: process.env.NOTIFICATION_DRAIN_INTERVAL_MS,
    NOTIFICATION_LEASE_SECONDS: process.env.NOTIFICATION_LEASE_SECONDS,
    NOTIFICATION_RETRY_BASE_SECONDS:
      process.env.NOTIFICATION_RETRY_BASE_SECONDS,
    MAX_OWNED_DOCUMENTS: process.env.MAX_OWNED_DOCUMENTS,
    MAX_COMMENTS_PER_DOCUMENT: process.env.MAX_COMMENTS_PER_DOCUMENT,
    MAX_ACTIVE_SHARES_PER_DOCUMENT: process.env.MAX_ACTIVE_SHARES_PER_DOCUMENT,
    MAX_REVISIONS_PER_DOCUMENT: process.env.MAX_REVISIONS_PER_DOCUMENT,
  };
}
