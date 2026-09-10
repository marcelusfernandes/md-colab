declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ACCESS_MODE?: string;
    APP_ORIGIN?: string;
    APP_AUTHOR_EMAILS?: string;
    APP_OWNER_EMAIL?: string;
    APP_OWNER_NAME?: string;
    RESEND_API_KEY?: string;
    MAIL_FROM?: string;
  }
}
