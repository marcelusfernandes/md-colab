import {
  NotificationSendError,
  ResendNotificationTransport,
  notificationTransportTimeoutMs,
  type NotificationTransport,
} from './notification-transport.ts';

const resendIdempotencyWindowSeconds = 24 * 60 * 60;
const retryCutoffMarginSeconds =
  Math.ceil(notificationTransportTimeoutMs / 1000) + 5;
const defaultLeaseSeconds = 60;
const defaultRetryBaseSeconds = 30;
const defaultLimit = 10;
const maximumAttempts = 8;

type DeliveryCandidate = {
  id: string;
  event_id: string;
  recipient_id: string;
  recipient_email: string;
  status: string;
  attempts: number;
  first_attempt_at: number | null;
  uncertain: number;
  idempotency_key: string | null;
  payload: string | null;
  document_id: string;
  comment_id: string;
};

type PersistedPayload = {
  from: string;
  to: [string];
  subject: string;
  text: string;
};

export type NotificationDrainResult = {
  examined: number;
  sent: number;
  retried: number;
  blocked: number;
  suppressed: number;
};

export type NotificationDrainOptions = {
  now?: () => number;
  randomUUID?: () => string;
  transport?: NotificationTransport;
  limit?: number;
};

function positiveInteger(
  value: string | undefined,
  fallback: number,
  minimum = 1,
) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function origin(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const loopback =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (
      parsed.origin !== value ||
      (parsed.protocol !== 'https:' &&
        !(parsed.protocol === 'http:' && loopback))
    )
      return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function mailFrom(value: string | undefined) {
  if (!value || value.trim() !== value || /[\r\n]/.test(value)) return null;
  return value;
}

function payloadFor(
  candidate: DeliveryCandidate,
  appOrigin: string,
  from: string,
): PersistedPayload {
  const link = `${appOrigin}/d/${candidate.document_id}?comment=${candidate.comment_id}`;
  return {
    from,
    to: [candidate.recipient_email],
    subject: 'Nova crítica em um plano compartilhado',
    text: `Há uma nova crítica ou resposta em um plano ao qual você tem acesso.\n\n${link}\n\nAbrir este aviso apenas mostra o contexto da conversa. Nenhuma decisão é alterada e o plano não é executado.`,
  };
}

function validPersistedPayload(value: string, candidate: DeliveryCandidate) {
  try {
    const parsed = JSON.parse(value) as Partial<PersistedPayload>;
    return (
      parsed &&
      typeof parsed === 'object' &&
      Object.keys(parsed).sort().join(',') === 'from,subject,text,to' &&
      typeof parsed.from === 'string' &&
      typeof parsed.subject === 'string' &&
      typeof parsed.text === 'string' &&
      Array.isArray(parsed.to) &&
      parsed.to.length === 1 &&
      parsed.to[0] === candidate.recipient_email
    );
  } catch {
    return false;
  }
}

function retryDelay(attempt: number, base: number, retryAfter?: number) {
  const backoff = Math.min(60 * 60, base * 2 ** Math.min(attempt - 1, 6));
  return Math.max(backoff, retryAfter ?? 0);
}

function claimableSql(now: number) {
  return `((status='pending' AND available_at<=${now}) OR (status='leased' AND lease_expires_at<=${now}))`;
}

async function nextCandidate(db: D1Database, now: number) {
  return db
    .prepare(
      `SELECT d.id,d.event_id,d.recipient_id,d.recipient_email,d.status,d.attempts,
         d.first_attempt_at,d.uncertain,d.idempotency_key,d.payload,
         e.document_id,e.comment_id
       FROM notification_deliveries d
       JOIN notification_events e ON e.id=d.event_id
       WHERE (d.status='pending' AND d.available_at<=?)
          OR (d.status='leased' AND d.lease_expires_at<=?)
       ORDER BY d.available_at,d.created_at,d.id LIMIT 1`,
    )
    .bind(now, now)
    .first<DeliveryCandidate>();
}

async function suppressIfUnauthorized(
  db: D1Database,
  candidate: DeliveryCandidate,
  now: number,
) {
  await db
    .prepare(
      `UPDATE notification_deliveries SET status='suppressed',lease_token=NULL,
         lease_expires_at=NULL,last_error_code='access_revoked',last_error_at=?
       WHERE id=? AND ${claimableSql(now)} AND NOT EXISTS(
         SELECT 1 FROM notification_events e
         JOIN documents doc ON doc.id=e.document_id
         JOIN users u ON u.id=notification_deliveries.recipient_id
         WHERE e.id=notification_deliveries.event_id
           AND doc.is_test=0 AND u.test_email IS NULL
           AND u.email=notification_deliveries.recipient_email
           AND (doc.owner_id=u.id OR EXISTS(
             SELECT 1 FROM shares s
             WHERE s.document_id=doc.id AND s.email=u.email
           ))
       )`,
    )
    .bind(now, candidate.id)
    .run();
  const row = await db
    .prepare('SELECT status FROM notification_deliveries WHERE id=?')
    .bind(candidate.id)
    .first<{ status: string }>();
  return row?.status === 'suppressed';
}

async function markBlocked(
  db: D1Database,
  candidate: DeliveryCandidate,
  now: number,
  code: string,
) {
  await db
    .prepare(
      `UPDATE notification_deliveries SET status='blocked',lease_token=NULL,
         lease_expires_at=NULL,last_error_code=?,last_error_at=?
       WHERE id=? AND ${claimableSql(now)}`,
    )
    .bind(code, now, candidate.id)
    .run();
}

async function deferConfiguration(
  db: D1Database,
  candidate: DeliveryCandidate,
  now: number,
) {
  await db
    .prepare(
      `UPDATE notification_deliveries SET status='pending',available_at=?,
         lease_token=NULL,lease_expires_at=NULL,
         last_error_code='notification_configuration',last_error_at=?
       WHERE id=? AND ${claimableSql(now)}`,
    )
    .bind(now + 300, now, candidate.id)
    .run();
}

async function claim(
  db: D1Database,
  candidate: DeliveryCandidate,
  now: number,
  leaseSeconds: number,
  leaseToken: string,
  idempotencyKey: string,
  payload: string,
) {
  return db
    .prepare(
      `UPDATE notification_deliveries SET status='leased',lease_token=?,
         lease_expires_at=?,attempts=attempts+1,
         first_attempt_at=COALESCE(first_attempt_at,?),uncertain=1,
         idempotency_key=COALESCE(idempotency_key,?),payload=COALESCE(payload,?),
         last_error_code=NULL,last_error_at=NULL
       WHERE id=? AND ${claimableSql(now)} AND EXISTS(
         SELECT 1 FROM notification_events e
         JOIN documents doc ON doc.id=e.document_id
         JOIN users u ON u.id=notification_deliveries.recipient_id
         WHERE e.id=notification_deliveries.event_id
           AND doc.is_test=0 AND u.test_email IS NULL
           AND u.email=notification_deliveries.recipient_email
           AND (doc.owner_id=u.id OR EXISTS(
             SELECT 1 FROM shares s
             WHERE s.document_id=doc.id AND s.email=u.email
           ))
       )
       RETURNING id,idempotency_key,payload`,
    )
    .bind(
      leaseToken,
      now + leaseSeconds,
      now,
      idempotencyKey,
      payload,
      candidate.id,
    )
    .first<{ id: string; idempotency_key: string; payload: string }>();
}

export async function drainNotifications(
  values: Cloudflare.Env,
  options: NotificationDrainOptions = {},
): Promise<NotificationDrainResult> {
  const result: NotificationDrainResult = {
    examined: 0,
    sent: 0,
    retried: 0,
    blocked: 0,
    suppressed: 0,
  };
  if (values.ACCESS_MODE === 'test') return result;

  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const limit = Math.min(
    100,
    options.limit ??
      positiveInteger(values.NOTIFICATION_DRAIN_LIMIT, defaultLimit),
  );
  const leaseSeconds = positiveInteger(
    values.NOTIFICATION_LEASE_SECONDS,
    defaultLeaseSeconds,
    15,
  );
  const retryBaseSeconds = positiveInteger(
    values.NOTIFICATION_RETRY_BASE_SECONDS,
    defaultRetryBaseSeconds,
  );
  const appOrigin = origin(values.APP_ORIGIN);
  const from = mailFrom(values.MAIL_FROM);
  const transport =
    options.transport ?? new ResendNotificationTransport(values.RESEND_API_KEY);

  for (let index = 0; index < limit; index += 1) {
    const current = now();
    const candidate = await nextCandidate(values.DB, current);
    if (!candidate) break;
    result.examined += 1;

    if (await suppressIfUnauthorized(values.DB, candidate, current)) {
      result.suppressed += 1;
      continue;
    }
    if (
      !values.RESEND_API_KEY ||
      (candidate.payload === null && (!appOrigin || !from))
    ) {
      await deferConfiguration(values.DB, candidate, current);
      result.retried += 1;
      continue;
    }
    if (
      candidate.first_attempt_at !== null &&
      candidate.uncertain === 1 &&
      current >=
        candidate.first_attempt_at +
          resendIdempotencyWindowSeconds -
          retryCutoffMarginSeconds
    ) {
      await markBlocked(
        values.DB,
        candidate,
        current,
        'uncertain_window_elapsed',
      );
      result.blocked += 1;
      continue;
    }
    if (candidate.attempts >= maximumAttempts) {
      await markBlocked(
        values.DB,
        candidate,
        current,
        candidate.uncertain === 1
          ? 'uncertain_attempts_exhausted'
          : 'attempts_exhausted',
      );
      result.blocked += 1;
      continue;
    }
    if (
      (candidate.idempotency_key === null) !== (candidate.payload === null) ||
      (candidate.payload !== null &&
        !validPersistedPayload(candidate.payload, candidate))
    ) {
      await markBlocked(
        values.DB,
        candidate,
        current,
        'persisted_payload_invalid',
      );
      result.blocked += 1;
      continue;
    }

    const idempotencyKey =
      candidate.idempotency_key ?? `comment-notification/${candidate.id}`;
    const payload =
      candidate.payload ??
      JSON.stringify(payloadFor(candidate, appOrigin!, from!));
    const leaseToken = randomUUID();
    const claimed = await claim(
      values.DB,
      candidate,
      current,
      leaseSeconds,
      leaseToken,
      idempotencyKey,
      payload,
    );
    if (!claimed) continue;

    try {
      const sent = await transport.sendNotification({
        idempotencyKey: claimed.idempotency_key,
        payload: claimed.payload,
      });
      await values.DB.prepare(
        `UPDATE notification_deliveries SET status='sent',provider_id=?,
             lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,last_error_at=NULL
           WHERE id=? AND status='leased' AND lease_token=?`,
      )
        .bind(sent.providerId, candidate.id, leaseToken)
        .run();
      const row = await values.DB.prepare(
        'SELECT status FROM notification_deliveries WHERE id=?',
      )
        .bind(candidate.id)
        .first<{ status: string }>();
      if (row?.status === 'sent') result.sent += 1;
      else if (row?.status === 'suppressed') result.suppressed += 1;
    } catch (error) {
      const completedAt = now();
      const failure =
        error instanceof NotificationSendError
          ? error
          : new NotificationSendError('provider_unknown', true, true);
      const uncertain = candidate.uncertain === 1 || failure.uncertain;
      const attempt = candidate.attempts + 1;
      const shouldRetry = failure.retryable && attempt < maximumAttempts;
      const status = shouldRetry ? 'pending' : 'blocked';
      const code =
        !shouldRetry && uncertain ? `uncertain_${failure.code}` : failure.code;
      const delay = retryDelay(
        attempt,
        retryBaseSeconds,
        failure.retryAfterSeconds,
      );
      const availableAt =
        completedAt + Math.min(delay, Number.MAX_SAFE_INTEGER - completedAt);
      await values.DB.prepare(
        `UPDATE notification_deliveries SET status=?,available_at=?,uncertain=?,
             lease_token=NULL,lease_expires_at=NULL,last_error_code=?,last_error_at=?
           WHERE id=? AND status='leased' AND lease_token=?`,
      )
        .bind(
          status,
          availableAt,
          uncertain ? 1 : 0,
          code,
          completedAt,
          candidate.id,
          leaseToken,
        )
        .run();
      const row = await values.DB.prepare(
        'SELECT status FROM notification_deliveries WHERE id=?',
      )
        .bind(candidate.id)
        .first<{ status: string }>();
      if (row?.status === 'pending') result.retried += 1;
      else if (row?.status === 'blocked') result.blocked += 1;
      else if (row?.status === 'suppressed') result.suppressed += 1;
    }
  }
  return result;
}
