export type NotificationEmail = {
  idempotencyKey: string;
  payload: string;
};

export type NotificationSendResult = { providerId: string };

export class NotificationSendError extends Error {
  constructor(
    public code: string,
    public retryable: boolean,
    public uncertain: boolean,
    public retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

export interface NotificationTransport {
  sendNotification(message: NotificationEmail): Promise<NotificationSendResult>;
}

export const notificationTransportTimeoutMs = 10_000;

function retryAfterSeconds(value: string | null) {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : Number.MAX_SAFE_INTEGER;
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

export class ResendNotificationTransport implements NotificationTransport {
  constructor(
    private apiKey: string | undefined,
    private transport: typeof fetch = fetch,
  ) {}

  async sendNotification(
    message: NotificationEmail,
  ): Promise<NotificationSendResult> {
    if (!this.apiKey)
      throw new NotificationSendError('provider_configuration', false, false);

    let response: Response;
    try {
      response = await this.transport('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + this.apiKey,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: message.payload,
        signal: AbortSignal.timeout(notificationTransportTimeoutMs),
      });
    } catch {
      throw new NotificationSendError('provider_network', true, true);
    }

    let body: { id?: unknown; name?: unknown } | undefined;
    try {
      body = (await response.json()) as { id?: unknown; name?: unknown };
    } catch {
      if (response.ok)
        throw new NotificationSendError(
          'provider_invalid_response',
          true,
          true,
        );
    }

    if (response.ok) {
      if (typeof body?.id !== 'string' || body.id.length === 0)
        throw new NotificationSendError(
          'provider_invalid_response',
          true,
          true,
        );
      return { providerId: body.id };
    }

    const providerName = typeof body?.name === 'string' ? body.name : '';
    if (response.status === 429)
      throw new NotificationSendError(
        'provider_rate_limit',
        true,
        false,
        retryAfterSeconds(response.headers.get('retry-after')),
      );
    if (
      response.status === 409 &&
      providerName === 'concurrent_idempotent_requests'
    )
      throw new NotificationSendError(
        'provider_concurrent_request',
        true,
        true,
      );
    if (
      response.status === 409 &&
      providerName === 'invalid_idempotent_request'
    )
      throw new NotificationSendError(
        'provider_payload_divergent',
        false,
        false,
      );
    if (response.status === 409)
      throw new NotificationSendError('provider_conflict', true, true);
    if (response.status >= 500)
      throw new NotificationSendError('provider_unavailable', true, true);
    if (response.status === 401 || response.status === 403)
      throw new NotificationSendError('provider_configuration', false, false);
    throw new NotificationSendError('provider_rejected', false, false);
  }
}
