import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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
    isTest: integer('is_test').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('documents_owner').on(table.ownerId)],
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

export const magicLinks = sqliteTable(
  'magic_links',
  {
    tokenHash: text('token_hash').primaryKey(),
    email: text('email').notNull(),
    documentId: text('document_id').references(() => documents.id),
    commentId: text('comment_id').references(() => comments.id),
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
