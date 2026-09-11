export type NotificationEvidence = 'accepted' | 'confirmed_not_delivered';

export type ReconciliationInput = {
  actionId: string;
  deliveryId: string;
  operatorId: string;
  evidence: NotificationEvidence;
  note: string;
  providerId?: string;
};

type ReconciliationRow = {
  action_id: string;
  delivery_id: string;
  operator_id: string;
  evidence: NotificationEvidence;
  provider_id: string | null;
  note: string;
  result_delivery_id: string | null;
  created_at: string;
};

function required(value: string, label: string, maximum: number) {
  if (!value || value.trim() !== value || value.length > maximum)
    throw new Error(`${label} is invalid.`);
  return value;
}

function validate(input: ReconciliationInput) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.actionId,
    )
  )
    throw new Error('actionId must be a UUID.');
  required(input.deliveryId, 'deliveryId', 128);
  required(input.operatorId, 'operatorId', 128);
  required(input.note, 'note', 500);
  if (!['accepted', 'confirmed_not_delivered'].includes(input.evidence))
    throw new Error('evidence is invalid.');
  if (input.evidence === 'accepted')
    required(input.providerId ?? '', 'providerId', 256);
  else if (input.providerId !== undefined)
    throw new Error('providerId is only valid for accepted evidence.');
}

function sameAction(row: ReconciliationRow, input: ReconciliationInput) {
  return (
    row.delivery_id === input.deliveryId &&
    row.operator_id === input.operatorId &&
    row.evidence === input.evidence &&
    row.note === input.note &&
    row.provider_id === (input.providerId ?? null)
  );
}

async function reconciliation(db: D1Database, actionId: string) {
  return db
    .prepare(
      `SELECT action_id,delivery_id,operator_id,evidence,provider_id,note,
         result_delivery_id,created_at
       FROM notification_reconciliations WHERE action_id=?`,
    )
    .bind(actionId)
    .first<ReconciliationRow>();
}

export type NotificationInspection = {
  deliveryId?: string;
  status?: 'blocked' | 'pending' | 'suppressed' | 'sent' | 'all';
  cursor?: string;
  limit?: number;
};

function inspectionCursor(createdAt: string, id: string) {
  return btoa(JSON.stringify({ v: 1, createdAt, id }));
}

function parseInspectionCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as {
      v?: unknown;
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      parsed.v !== 1 ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      inspectionCursor(parsed.createdAt, parsed.id) !== value
    )
      throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error('Inspection cursor is invalid.');
  }
}

export async function inspectNotifications(
  db: D1Database,
  inspection: NotificationInspection = {},
) {
  const limit = inspection.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Inspection limit must be between 1 and 100.');
  const status = inspection.status ?? 'blocked';
  if (!['blocked', 'pending', 'suppressed', 'sent', 'all'].includes(status))
    throw new Error('Inspection status is invalid.');
  const cursor = parseInspectionCursor(inspection.cursor);
  if (inspection.deliveryId && cursor)
    throw new Error('A delivery filter cannot be combined with a cursor.');
  const conditions = [
    ...(inspection.deliveryId ? ['d.id=?'] : []),
    ...(!inspection.deliveryId && status !== 'all' ? ['d.status=?'] : []),
    ...(!inspection.deliveryId && cursor
      ? ['(d.created_at>? OR (d.created_at=? AND d.id>?))']
      : []),
  ];
  const values = [
    ...(inspection.deliveryId ? [inspection.deliveryId] : []),
    ...(!inspection.deliveryId && status !== 'all' ? [status] : []),
    ...(!inspection.deliveryId && cursor
      ? [cursor.createdAt, cursor.createdAt, cursor.id]
      : []),
    inspection.deliveryId ? 1 : limit + 1,
  ];
  const query = db.prepare(
    `SELECT d.id,d.event_id,e.document_id,e.comment_id,d.recipient_id,
       d.recipient_email,d.generation,d.retry_of_id,d.status,d.available_at,
       d.lease_expires_at,d.attempts,d.first_attempt_at,d.uncertain,
       d.idempotency_key,d.provider_id,d.last_error_code,d.last_error_at,
       d.created_at
     FROM notification_deliveries d
     JOIN notification_events e ON e.id=d.event_id
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY d.created_at,d.id LIMIT ?`,
  );
  const rows = (await query.bind(...values).all()).results as Array<
    Record<string, unknown> & { id: string; created_at: string }
  >;
  const deliveries = inspection.deliveryId ? rows : rows.slice(0, limit);
  const last = deliveries.at(-1);
  return {
    deliveries,
    nextCursor:
      !inspection.deliveryId && rows.length > limit && last
        ? inspectionCursor(last.created_at, last.id)
        : null,
  };
}

export async function reconcileNotification(
  db: D1Database,
  input: ReconciliationInput,
) {
  validate(input);
  const existing = await reconciliation(db, input.actionId);
  if (existing) {
    if (!sameAction(existing, input))
      throw new Error('actionId already exists with different evidence.');
    return existing;
  }

  const resultDeliveryId =
    input.evidence === 'confirmed_not_delivered' ? crypto.randomUUID() : null;
  try {
    await db
      .prepare(
        `INSERT INTO notification_reconciliations (
           action_id,delivery_id,operator_id,evidence,provider_id,note,
           result_delivery_id,created_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(
        input.actionId,
        input.deliveryId,
        input.operatorId,
        input.evidence,
        input.providerId ?? null,
        input.note,
        resultDeliveryId,
        new Date().toISOString(),
      )
      .run();
  } catch (error) {
    const raced = await reconciliation(db, input.actionId);
    if (raced && sameAction(raced, input)) return raced;
    throw error;
  }
  const created = await reconciliation(db, input.actionId);
  if (!created) throw new Error('Reconciliation was not persisted.');
  return created;
}
