import {
  check,
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  testEmail: text('test_email'),
});
export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    filename: text('filename').notNull(),
    markdown: text('markdown').notNull(),
    currentRevisionId: text('current_revision_id'),
    isTest: integer('is_test').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('documents_owner').on(table.ownerId)],
);
export const documentRevisions = sqliteTable(
  'document_revisions',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    ordinal: integer('ordinal').notNull(),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    filename: text('filename').notNull(),
    markdown: text('markdown').notNull(),
    baseRevisionId: text('base_revision_id').references(
      (): AnySQLiteColumn => documentRevisions.id,
    ),
    summary: text('summary'),
    consideredCommentIds: text('considered_comment_ids').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('document_revisions_document_ordinal').on(
      table.documentId,
      table.ordinal,
    ),
    index('document_revisions_document').on(table.documentId),
  ],
);
export const shares = sqliteTable(
  'shares',
  {
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    email: text('email').notNull(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.email] }),
    index('shares_email').on(table.email),
  ],
);
export const comments = sqliteTable(
  'comments',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    quote: text('quote').notNull(),
    sourceStart: integer('source_start'),
    sourceRevisionId: text('source_revision_id').references(
      () => documentRevisions.id,
    ),
    // A root points to itself; replies point to that stable root. It remains
    // nullable in the physical schema only for the legacy INSERT trigger.
    rootId: text('root_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('comments_document_created').on(table.documentId, table.createdAt),
    index('comments_document_sequence').on(table.documentId, table.sequence),
    index('comments_document_root_sequence').on(
      table.documentId,
      table.rootId,
      table.sequence,
    ),
  ],
);

export const conversationEvents = sqliteTable(
  'conversation_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    rootId: text('root_id').notNull(),
    actorId: text('actor_id')
      .notNull()
      .references(() => users.id),
    baseVersion: integer('base_version').notNull(),
    version: integer('version').notNull(),
    action: text('action').notNull(),
    state: text('state').notNull(),
    decision: text('decision'),
    decisionReason: text('decision_reason'),
    reason: text('reason'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('conversation_events_root_version').on(
      table.rootId,
      table.version,
    ),
    index('conversation_events_document_sequence').on(
      table.documentId,
      table.sequence,
    ),
    index('conversation_events_root_sequence').on(
      table.rootId,
      table.sequence,
    ),
  ],
);

export const conversationChanges = sqliteTable(
  'conversation_changes',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    rootId: text('root_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('conversation_changes_document_sequence').on(
      table.documentId,
      table.sequence,
    ),
  ],
);

export const notificationEvents = sqliteTable(
  'notification_events',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull().default('comment'),
    commentId: text('comment_id').unique().references(() => comments.id),
    revisionId: text('revision_id')
      .unique()
      .references(() => documentRevisions.id),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    rootId: text('root_id'),
    actorId: text('actor_id')
      .notNull()
      .references(() => users.id),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('notification_events_document').on(table.documentId),
    check(
      'notification_events_target',
      sql`(${table.kind} = 'comment' AND ${table.commentId} IS NOT NULL AND ${table.rootId} IS NOT NULL AND ${table.revisionId} IS NULL) OR (${table.kind} = 'revision' AND ${table.commentId} IS NULL AND ${table.rootId} IS NULL AND ${table.revisionId} IS NOT NULL)`,
    ),
  ],
);

export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => notificationEvents.id),
    recipientId: text('recipient_id')
      .notNull()
      .references(() => users.id),
    recipientEmail: text('recipient_email').notNull(),
    generation: integer('generation').notNull().default(1),
    retryOfId: text('retry_of_id'),
    status: text('status').notNull().default('pending'),
    availableAt: integer('available_at').notNull(),
    leaseToken: text('lease_token'),
    leaseExpiresAt: integer('lease_expires_at'),
    attempts: integer('attempts').notNull().default(0),
    firstAttemptAt: integer('first_attempt_at'),
    uncertain: integer('uncertain').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
    payload: text('payload'),
    providerId: text('provider_id'),
    lastErrorCode: text('last_error_code'),
    lastErrorAt: integer('last_error_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('notification_deliveries_event_recipient_generation').on(
      table.eventId,
      table.recipientId,
      table.generation,
    ),
    uniqueIndex('notification_deliveries_retry_of').on(table.retryOfId),
    index('notification_deliveries_ready').on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const notificationReconciliations = sqliteTable(
  'notification_reconciliations',
  {
    actionId: text('action_id').primaryKey(),
    deliveryId: text('delivery_id')
      .notNull()
      .references(() => notificationDeliveries.id),
    operatorId: text('operator_id').notNull(),
    evidence: text('evidence').notNull(),
    providerId: text('provider_id'),
    note: text('note'),
    resultDeliveryId: text('result_delivery_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('notification_reconciliations_delivery').on(table.deliveryId),
  ],
);

export const magicLinks = sqliteTable(
  'magic_links',
  {
    tokenHash: text('token_hash').primaryKey(),
    email: text('email').notNull(),
    documentId: text('document_id').references(() => documents.id),
    commentId: text('comment_id').references(() => comments.id),
    revisionId: text('revision_id').references(() => documentRevisions.id),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
  },
  (table) => [index('magic_links_expiry').on(table.expiresAt)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('sessions_expiry').on(table.expiresAt)],
);

export const authLimits = sqliteTable(
  'auth_limits',
  {
    scope: text('scope').notNull(),
    keyHash: text('key_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    count: integer('count').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.keyHash] }),
    index('auth_limits_expiry').on(table.expiresAt),
  ],
);

export const publishingTokens = sqliteTable(
  'publishing_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: text('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (table) => [
    index('publishing_tokens_user_created').on(table.userId, table.createdAt),
    index('publishing_tokens_expiry').on(table.expiresAt),
  ],
);

export const publications = sqliteTable(
  'publications',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    publishingTokenId: text('publishing_token_id')
      .notNull()
      .references(() => publishingTokens.id),
    idempotencyKeyHash: text('idempotency_key_hash').notNull(),
    payloadDigest: text('payload_digest').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('publications_author_idempotency').on(
      table.authorId,
      table.idempotencyKeyHash,
    ),
    uniqueIndex('publications_document').on(table.documentId),
  ],
);
