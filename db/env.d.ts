declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ACCESS_MODE?: string;
    APP_ORIGIN?: string;
    APP_AUTHOR_MODE?: string;
    APP_AUTHOR_EMAILS?: string;
    APP_OWNER_EMAIL?: string;
    APP_OWNER_NAME?: string;
    RESEND_API_KEY?: string;
    MAIL_FROM?: string;
    NOTIFICATION_DRAIN_LIMIT?: string;
    NOTIFICATION_DRAIN_INTERVAL_MS?: string;
    NOTIFICATION_LEASE_SECONDS?: string;
    NOTIFICATION_RETRY_BASE_SECONDS?: string;
    MAX_OWNED_DOCUMENTS?: string;
    MAX_COMMENTS_PER_DOCUMENT?: string;
    MAX_ACTIVE_SHARES_PER_DOCUMENT?: string;
  }
}

declare module 'virtual:md-colab-runtime-bindings' {
  export function getRuntimeBindings(): Cloudflare.Env;
}
