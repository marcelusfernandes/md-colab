import { HttpError } from './document-service.ts';
import type { AuthenticatedToken } from './publication-service.ts';

const feedbackPageSize = 50;
const feedbackContractVersion = 1;

type FeedbackState = {
  document_id: string;
  title: string;
  filename: string;
  current_revision_id: string;
  current_revision_ordinal: number;
  max_change: number;
  comment_count: number;
  event_count: number;
  revision_count: number;
};

type FeedbackStamp = {
  v: 1;
  type: 'feedback';
  documentId: string;
  credentialId: string;
  currentRevisionId: string;
  maxChange: number;
};

type FeedbackCursor = {
  v: 1;
  type: 'feedback-page';
  collection: 'comments' | 'events';
  documentId: string;
  credentialId: string;
  stamp: string;
  sequence: number;
};

type FeedbackCommentRow = {
  transport_sequence: number;
  id: string;
  root_id: string;
  author_id: string;
  author_name: string;
  body: string;
  quote: string;
  source_start: number | null;
  source_revision_id: string;
  created_at: string;
  is_root: number;
  state: 'open' | 'closed' | null;
  version: number | null;
  decision: 'follow' | 'refute' | 'defer' | null;
  decision_reason: string | null;
  reply_count: number | null;
};

type FeedbackEventRow = {
  transport_sequence: number;
  id: string;
  root_id: string;
  actor_id: string;
  actor_name: string;
  base_version: number;
  version: number;
  action: 'close' | 'reopen' | 'follow' | 'refute' | 'defer';
  state: 'open' | 'closed';
  decision: 'follow' | 'refute' | 'defer' | null;
  decision_reason: string | null;
  reason: string | null;
  created_at: string;
};

type FeedbackRevisionRow = {
  id: string;
  document_id: string;
  ordinal: number;
  author_id: string;
  author_name: string;
  title: string;
  filename: string;
  markdown: string;
  base_revision_id: string | null;
  summary: string | null;
  considered_comment_ids: string;
  created_at: string;
};

function base64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function base64Text(value: string) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function validOpaque(value: string) {
  return (
    value.length > 0 && value.length <= 4096 && /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function validSequence(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function encodeStamp(stamp: FeedbackStamp) {
  return base64Url(JSON.stringify(stamp));
}

function decodeStamp(
  value: string,
  credential: AuthenticatedToken,
  documentId: string,
) {
  try {
    if (!validOpaque(value)) throw new Error();
    const stamp = JSON.parse(base64Text(value)) as Partial<FeedbackStamp>;
    if (
      !stamp ||
      typeof stamp !== 'object' ||
      Array.isArray(stamp) ||
      Object.keys(stamp).sort().join(',') !==
        'credentialId,currentRevisionId,documentId,maxChange,type,v' ||
      stamp.v !== feedbackContractVersion ||
      stamp.type !== 'feedback' ||
      stamp.documentId !== documentId ||
      stamp.credentialId !== credential.credentialId ||
      typeof stamp.currentRevisionId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(stamp.currentRevisionId) ||
      !validSequence(stamp.maxChange) ||
      encodeStamp(stamp as FeedbackStamp) !== value
    )
      throw new Error();
    return stamp as FeedbackStamp;
  } catch {
    throw new HttpError(400, 'Selo de feedback inválido.');
  }
}

function encodeCursor(cursor: FeedbackCursor) {
  return base64Url(JSON.stringify(cursor));
}

function decodeCursor(
  value: string,
  collection: FeedbackCursor['collection'],
  credential: AuthenticatedToken,
  documentId: string,
  stamp: string,
) {
  try {
    if (!validOpaque(value)) throw new Error();
    const cursor = JSON.parse(base64Text(value)) as Partial<FeedbackCursor>;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !==
        'collection,credentialId,documentId,sequence,stamp,type,v' ||
      cursor.v !== feedbackContractVersion ||
      cursor.type !== 'feedback-page' ||
      cursor.collection !== collection ||
      cursor.documentId !== documentId ||
      cursor.credentialId !== credential.credentialId ||
      cursor.stamp !== stamp ||
      !validSequence(cursor.sequence) ||
      encodeCursor(cursor as FeedbackCursor) !== value
    )
      throw new Error();
    return cursor.sequence!;
  } catch {
    throw new HttpError(400, 'Cursor de feedback inválido.');
  }
}

function changed() {
  return new HttpError(
    409,
    'O feedback mudou durante a leitura. Inicie uma nova coleta.',
    'feedback_changed',
  );
}

function credentialUnavailable() {
  return new HttpError(401, 'Credencial de agente inválida ou ausente.');
}

function stampFor(state: FeedbackState, credentialId: string): FeedbackStamp {
  return {
    v: feedbackContractVersion,
    type: 'feedback',
    documentId: state.document_id,
    credentialId,
    currentRevisionId: state.current_revision_id,
    maxChange: Number(state.max_change),
  };
}

function assertSameStamp(state: FeedbackState, expected: FeedbackStamp) {
  if (
    state.document_id !== expected.documentId ||
    state.current_revision_id !== expected.currentRevisionId ||
    Number(state.max_change) !== expected.maxChange
  )
    throw changed();
}

export class FeedbackService {
  constructor(
    private db: D1Database,
    private credential: AuthenticatedToken,
    private now = () => Math.floor(Date.now() / 1000),
  ) {}

  private async state(documentId: string) {
    const state = await this.db
      .prepare(
        `SELECT d.id AS document_id,r.title,r.filename,
           r.id AS current_revision_id,r.ordinal AS current_revision_ordinal,
           (SELECT COALESCE(max(sequence),0) FROM conversation_changes
             WHERE document_id=d.id) AS max_change,
           (SELECT count(*) FROM comments WHERE document_id=d.id) AS comment_count,
           (SELECT count(*) FROM conversation_events WHERE document_id=d.id) AS event_count,
           (SELECT count(*) FROM document_revisions WHERE document_id=d.id) AS revision_count
         FROM publishing_tokens p
         JOIN users u ON u.id=p.user_id
         JOIN documents d ON d.id=p.document_id
         JOIN document_revisions r
           ON r.id=d.current_revision_id AND r.document_id=d.id
         WHERE p.id=? AND p.token_hash=? AND p.user_id=? AND p.scope='plan_read'
           AND p.document_id=? AND p.revoked_at IS NULL AND p.expires_at>?
           AND u.test_email IS NULL AND d.owner_id=p.user_id AND d.is_test=0`,
      )
      .bind(
        this.credential.credentialId,
        this.credential.tokenHash,
        this.credential.viewer.id,
        documentId,
        this.now(),
      )
      .first<FeedbackState>();
    if (!state) throw credentialUnavailable();
    return state;
  }

  private async begin(documentId: string, encodedStamp: string) {
    if (
      this.credential.scope !== 'plan_read' ||
      this.credential.documentId !== documentId
    )
      throw credentialUnavailable();
    const stamp = decodeStamp(encodedStamp, this.credential, documentId);
    const state = await this.state(documentId);
    assertSameStamp(state, stamp);
    return stamp;
  }

  private async finish(documentId: string, stamp: FeedbackStamp) {
    const current = await this.state(documentId);
    assertSameStamp(current, stamp);
  }

  async manifest(documentId: string, encodedStamp?: string) {
    if (
      this.credential.scope !== 'plan_read' ||
      this.credential.documentId !== documentId
    )
      throw credentialUnavailable();
    const state = await this.state(documentId);
    const stamp = encodedStamp
      ? decodeStamp(encodedStamp, this.credential, documentId)
      : stampFor(state, this.credential.credentialId);
    assertSameStamp(state, stamp);
    await this.finish(documentId, stamp);
    return {
      contract_version: feedbackContractVersion,
      document: {
        id: state.document_id,
        title: state.title,
        filename: state.filename,
        current_revision_id: state.current_revision_id,
        current_revision_ordinal: Number(state.current_revision_ordinal),
      },
      counts: {
        comments: Number(state.comment_count),
        events: Number(state.event_count),
        revisions: Number(state.revision_count),
      },
      stamp: encodeStamp(stamp),
    };
  }

  async comments(documentId: string, encodedStamp: string, cursor?: string) {
    const stamp = await this.begin(documentId, encodedStamp);
    const boundary = cursor
      ? decodeCursor(
          cursor,
          'comments',
          this.credential,
          documentId,
          encodedStamp,
        )
      : 0;
    const rows = (
      await this.db
        .prepare(
          `SELECT c.sequence AS transport_sequence,c.id,
             COALESCE(c.root_id,c.id) AS root_id,c.author_id,u.name AS author_name,
             c.body,c.quote,c.source_start,c.source_revision_id,c.created_at,
             CASE WHEN COALESCE(c.root_id,c.id)=c.id THEN 1 ELSE 0 END AS is_root,
             CASE WHEN COALESCE(c.root_id,c.id)=c.id THEN COALESCE(e.state,'open') END AS state,
             CASE WHEN COALESCE(c.root_id,c.id)=c.id THEN COALESCE(e.version,0) END AS version,
             CASE WHEN COALESCE(c.root_id,c.id)=c.id THEN e.decision END AS decision,
             CASE WHEN COALESCE(c.root_id,c.id)=c.id THEN e.decision_reason END AS decision_reason,
             CASE WHEN COALESCE(c.root_id,c.id)=c.id THEN (
               SELECT count(*) FROM comments reply
               WHERE reply.document_id=c.document_id
                 AND COALESCE(reply.root_id,reply.id)=c.id AND reply.id<>c.id
             ) END AS reply_count
           FROM comments c JOIN users u ON u.id=c.author_id
           LEFT JOIN conversation_events e ON e.sequence=(
             SELECT latest.sequence FROM conversation_events latest
             WHERE latest.document_id=c.document_id
               AND latest.root_id=COALESCE(c.root_id,c.id)
             ORDER BY latest.version DESC LIMIT 1
           )
           WHERE c.document_id=? AND c.sequence>?
           ORDER BY c.sequence ASC LIMIT ?`,
        )
        .bind(documentId, boundary, feedbackPageSize + 1)
        .all<FeedbackCommentRow>()
    ).results;
    const page = rows.slice(0, feedbackPageSize);
    await this.finish(documentId, stamp);
    const comments = page.map((row) => {
      const {
        transport_sequence: _sequence,
        is_root,
        state,
        version,
        decision,
        decision_reason,
        reply_count,
        ...comment
      } = row;
      return {
        ...comment,
        is_root: Boolean(is_root),
        conversation: is_root
          ? {
              state,
              version: Number(version),
              decision,
              decision_reason,
              reply_count: Number(reply_count),
            }
          : null,
      };
    });
    const last = page.at(-1);
    return {
      comments,
      next_cursor:
        rows.length > feedbackPageSize && last
          ? encodeCursor({
              v: feedbackContractVersion,
              type: 'feedback-page',
              collection: 'comments',
              documentId,
              credentialId: this.credential.credentialId,
              stamp: encodedStamp,
              sequence: Number(last.transport_sequence),
            })
          : null,
      stamp: encodedStamp,
    };
  }

  async events(documentId: string, encodedStamp: string, cursor?: string) {
    const stamp = await this.begin(documentId, encodedStamp);
    const boundary = cursor
      ? decodeCursor(
          cursor,
          'events',
          this.credential,
          documentId,
          encodedStamp,
        )
      : 0;
    const rows = (
      await this.db
        .prepare(
          `SELECT e.sequence AS transport_sequence,e.id,e.root_id,e.actor_id,
             u.name AS actor_name,e.base_version,e.version,e.action,e.state,
             e.decision,e.decision_reason,e.reason,e.created_at
           FROM conversation_events e JOIN users u ON u.id=e.actor_id
           WHERE e.document_id=? AND e.sequence>?
           ORDER BY e.sequence ASC LIMIT ?`,
        )
        .bind(documentId, boundary, feedbackPageSize + 1)
        .all<FeedbackEventRow>()
    ).results;
    const page = rows.slice(0, feedbackPageSize);
    await this.finish(documentId, stamp);
    const events = page.map(
      ({ transport_sequence: _sequence, ...event }) => event,
    );
    const last = page.at(-1);
    return {
      events,
      next_cursor:
        rows.length > feedbackPageSize && last
          ? encodeCursor({
              v: feedbackContractVersion,
              type: 'feedback-page',
              collection: 'events',
              documentId,
              credentialId: this.credential.credentialId,
              stamp: encodedStamp,
              sequence: Number(last.transport_sequence),
            })
          : null,
      stamp: encodedStamp,
    };
  }

  async revision(documentId: string, revisionId: string, encodedStamp: string) {
    if (!/^[0-9a-f-]{36}$/i.test(revisionId))
      throw new HttpError(400, 'Revisão inválida.');
    const stamp = await this.begin(documentId, encodedStamp);
    const row = await this.db
      .prepare(
        `SELECT r.id,r.document_id,r.ordinal,r.author_id,u.name AS author_name,
           r.title,r.filename,r.markdown,r.base_revision_id,r.summary,
           r.considered_comment_ids,r.created_at
         FROM document_revisions r JOIN users u ON u.id=r.author_id
         WHERE r.document_id=? AND r.id=?`,
      )
      .bind(documentId, revisionId)
      .first<FeedbackRevisionRow>();
    if (!row) throw new HttpError(404, 'Revisão indisponível.');
    let consideredCommentIds: string[];
    try {
      const parsed = JSON.parse(row.considered_comment_ids) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.length > 100 ||
        parsed.some(
          (id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id),
        ) ||
        [...new Set(parsed)].sort((a, b) => a.localeCompare(b)).join(',') !==
          parsed.join(',')
      )
        throw new Error();
      consideredCommentIds = parsed as string[];
    } catch {
      throw new Error('Stored revision references are invalid.');
    }
    await this.finish(documentId, stamp);
    const { considered_comment_ids: _stored, ...revision } = row;
    return {
      revision: {
        ...revision,
        considered_comment_ids: consideredCommentIds,
      },
      stamp: encodedStamp,
    };
  }
}
