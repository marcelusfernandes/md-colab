import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './fixture.ts';
import { DocumentService } from '../lib/document-service.ts';
import {
  drainNotifications,
  type NotificationDrainOptions,
} from '../lib/notification-outbox.ts';
import {
  NotificationSendError,
  type NotificationEmail,
  type NotificationSendResult,
  type NotificationTransport,
} from '../lib/mailer.ts';
import { ResendNotificationTransport } from '../lib/notification-transport.ts';
import {
  inspectNotifications,
  reconcileNotification,
} from '../lib/notification-operations.ts';

class ControlledTransport implements NotificationTransport {
  messages: NotificationEmail[] = [];
  send = async (): Promise<NotificationSendResult> => ({
    providerId: 'sent-1',
  });

  async sendNotification(message: NotificationEmail) {
    this.messages.push(message);
    return this.send();
  }
}

async function fixture() {
  const { sqlite, db } = database();
  const owner = new DocumentService(db, {
    id: 'owner',
    name: 'Dono privado',
    email: 'owner@example.com',
  });
  const guest = new DocumentService(db, {
    id: 'guest',
    name: 'Convidado privado',
    email: 'guest@example.com',
  });
  const other = new DocumentService(db, {
    id: 'other',
    name: 'Outro privado',
    email: 'other@example.com',
  });
  await owner.registerViewer();
  await guest.registerViewer();
  await other.registerViewer();
  const document = await owner.create({
    id: crypto.randomUUID(),
    authorId: owner.viewer.id,
    title: 'Título que não pode vazar',
    filename: 'privado.md',
    markdown: '# Segredo\n\nConteúdo que não pode vazar.',
  });
  await owner.share(document.id, { email: guest.viewer.email, name: 'Guest' });
  await owner.share(document.id, { email: other.viewer.email, name: 'Other' });
  return { sqlite, db, owner, guest, other, document };
}

async function comment(
  service: DocumentService,
  documentId: string,
  body: string,
  rootId?: string,
) {
  const document = await service.document(documentId);
  return service.addComment(documentId, {
    id: crypto.randomUUID(),
    authorId: service.viewer.id,
    body,
    ...(rootId ? { rootId } : {}),
    ...(!rootId ? { sourceRevisionId: document.current_revision_id } : {}),
  });
}

function env(db: D1Database): Cloudflare.Env {
  return {
    DB: db,
    ACCESS_MODE: 'email',
    APP_ORIGIN: 'http://127.0.0.1:3999',
    RESEND_API_KEY: 're_synthetic',
    MAIL_FROM: 'Avisos <notices@example.com>',
    NOTIFICATION_RETRY_BASE_SECONDS: '1',
    NOTIFICATION_LEASE_SECONDS: '15',
  };
}

async function rows(db: D1Database) {
  return (
    await db
      .prepare(
        `SELECT d.*,e.kind,e.comment_id,e.revision_id,e.document_id FROM notification_deliveries d
         JOIN notification_events e ON e.id=d.event_id
         ORDER BY d.created_at,d.id`,
      )
      .all<Record<string, unknown>>()
  ).results;
}

async function revision(
  owner: DocumentService,
  documentId: string,
  id = crypto.randomUUID(),
) {
  const current = await owner.document(documentId);
  return owner.createRevision(documentId, {
    id,
    baseRevisionId: current.current_revision_id,
    title: 'Título novo que não pode vazar',
    filename: 'revisao-privada.md',
    markdown: '# Revisão\n\nConteúdo novo que não pode vazar.',
    summary: 'Resumo privado que não pode vazar.',
    consideredCommentIds: [],
  });
}

void test('snapshot atômico escolhe somente owner e autores prévios com acesso', async () => {
  const { sqlite, db, owner, guest, other, document } = await fixture();
  try {
    const root = await comment(guest, document.id, 'Raiz privada');
    assert.deepEqual(
      (await rows(db)).map((row) => row.recipient_id),
      ['owner'],
    );

    const reply = await comment(
      owner,
      document.id,
      'Resposta privada',
      root.id,
    );
    assert.deepEqual(
      (await rows(db))
        .filter((row) => row.comment_id === reply.id)
        .map((row) => row.recipient_id),
      ['guest'],
    );

    const secondReply = await comment(
      other,
      document.id,
      'Outra resposta',
      root.id,
    );
    assert.deepEqual(
      (await rows(db))
        .filter((row) => row.comment_id === secondReply.id)
        .map((row) => String(row.recipient_id))
        .sort((left, right) => left.localeCompare(right)),
      ['guest', 'owner'],
    );

    await other.addComment(document.id, {
      id: secondReply.id,
      authorId: other.viewer.id,
      body: 'Outra resposta',
      rootId: root.id,
    });
    assert.equal(
      (await rows(db)).filter((row) => row.comment_id === secondReply.id)
        .length,
      2,
    );
    assert.equal(
      (
        await db
          .prepare('SELECT count(*) AS count FROM notification_events')
          .first<{ count: number }>()
      )?.count,
      3,
    );
  } finally {
    sqlite.close();
  }
});

void test('falha no snapshot reverte o comentário e não cria evento órfão', async () => {
  const { sqlite, db, guest, document } = await fixture();
  try {
    sqlite.exec(`CREATE TRIGGER fail_notification_delivery BEFORE INSERT ON notification_deliveries
      BEGIN SELECT RAISE(ABORT,'synthetic notification failure'); END;`);
    const id = crypto.randomUUID();
    await assert.rejects(
      guest.addComment(document.id, {
        id,
        authorId: guest.viewer.id,
        body: 'Não deve persistir',
      }),
      /synthetic notification failure/,
    );
    assert.equal(
      (
        await db
          .prepare('SELECT count(*) AS count FROM comments WHERE id=?')
          .bind(id)
          .first<{ count: number }>()
      )?.count,
      0,
    );
    assert.equal(
      (
        await db
          .prepare(
            'SELECT count(*) AS count FROM notification_events WHERE id=?',
          )
          .bind(id)
          .first<{ count: number }>()
      )?.count,
      0,
    );
  } finally {
    sqlite.close();
  }
});

void test('republicação cria evento único e fotografa somente contribuidores atuais', async () => {
  const { sqlite, db, owner, guest, other, document } = await fixture();
  try {
    const firstComment = await comment(guest, document.id, 'Primeira crítica');
    await comment(guest, document.id, 'Segunda crítica');
    const published = await revision(owner, document.id, firstComment.id);
    assert.equal(published.replayed, false);

    const event = await db
      .prepare(
        `SELECT id,kind,comment_id,revision_id,document_id,root_id,actor_id
         FROM notification_events WHERE revision_id=?`,
      )
      .bind(firstComment.id)
      .first<Record<string, unknown>>();
    assert.ok(event);
    assert.deepEqual({ ...event }, {
      id: `revision:${firstComment.id}`,
      kind: 'revision',
      comment_id: null,
      revision_id: firstComment.id,
      document_id: document.id,
      root_id: null,
      actor_id: owner.viewer.id,
    });
    assert.deepEqual(
      (await rows(db))
        .filter((row) => row.event_id === event.id)
        .map((row) => row.recipient_id),
      [guest.viewer.id],
    );

    const replay = await owner.createRevision(document.id, {
      id: firstComment.id,
      baseRevisionId: document.current_revision_id,
      title: 'Título novo que não pode vazar',
      filename: 'revisao-privada.md',
      markdown: '# Revisão\n\nConteúdo novo que não pode vazar.',
      summary: 'Resumo privado que não pode vazar.',
      consideredCommentIds: [],
    });
    assert.equal(replay.replayed, true);
    assert.equal(
      (await rows(db)).filter((row) => row.event_id === event.id).length,
      1,
    );

    await comment(other, document.id, 'Crítica posterior');
    assert.equal(
      (await rows(db)).filter((row) => row.event_id === event.id).length,
      1,
    );
    await owner.revoke(document.id, guest.viewer.email);
    const second = await revision(owner, document.id);
    assert.deepEqual(
      (await rows(db))
        .filter((row) => row.revision_id === second.revision.id)
        .map((row) => row.recipient_id),
      [other.viewer.id],
    );
    await owner.share(document.id, {
      email: guest.viewer.email,
      name: guest.viewer.name,
    });
    const third = await revision(owner, document.id);
    assert.deepEqual(
      (await rows(db))
        .filter((row) => row.revision_id === third.revision.id)
        .map((row) => String(row.recipient_id))
        .sort(),
      [guest.viewer.id, other.viewer.id].sort(),
    );
  } finally {
    sqlite.close();
  }
});

void test('falha no snapshot de destinatários reverte revisão, evento e avanço', async () => {
  const { sqlite, owner, guest, document } = await fixture();
  try {
    await comment(guest, document.id, 'Crítica anterior');
    sqlite.exec(`CREATE TRIGGER fail_revision_notification
      BEFORE INSERT ON notification_deliveries
      FOR EACH ROW WHEN NEW.event_id LIKE 'revision:%'
      BEGIN SELECT RAISE(ABORT,'synthetic revision notification failure'); END;`);
    const revisionId = crypto.randomUUID();
    await assert.rejects(
      revision(owner, document.id, revisionId),
      /synthetic revision notification failure/,
    );
    assert.equal((await owner.document(document.id)).current_revision_id, document.id);
    assert.equal(
      sqlite
        .prepare('SELECT count(*) AS count FROM document_revisions WHERE id=?')
        .get(revisionId)?.count,
      0,
    );
    assert.equal(
      sqlite
        .prepare('SELECT count(*) AS count FROM notification_events WHERE revision_id=?')
        .get(revisionId)?.count,
      0,
    );
  } finally {
    sqlite.close();
  }
});

void test('dreno distingue comentário e revisão sem incluir conteúdo privado', async () => {
  const { sqlite, db, owner, guest, document } = await fixture();
  try {
    const created = await comment(guest, document.id, 'Corpo secreto');
    const published = await revision(owner, document.id);
    const transport = new ControlledTransport();
    const result = await drainNotifications(env(db), { transport, limit: 10 });
    assert.equal(result.sent, 2);
    assert.equal(transport.messages.length, 2);
    const commentMessage = transport.messages.find((message) =>
      message.payload.includes(`?comment=${created.id}`),
    );
    const revisionMessage = transport.messages.find((message) =>
      message.payload.includes(`?revision=${published.revision.id}`),
    );
    assert.ok(commentMessage);
    assert.ok(revisionMessage);
    assert.ok(commentMessage.idempotencyKey.startsWith('comment-notification/'));
    assert.ok(revisionMessage.idempotencyKey.startsWith('revision-notification/'));
    for (const message of transport.messages) {
      assert.equal(message.payload.includes('Título novo'), false);
      assert.equal(message.payload.includes('Resumo privado'), false);
      assert.equal(message.payload.includes('Conteúdo novo'), false);
      assert.equal(message.payload.includes('Corpo secreto'), false);
    }

    const inspected = await inspectNotifications(db, { status: 'sent' });
    assert.deepEqual(
      inspected.deliveries
        .map((delivery) => ({
          kind: delivery.kind,
          comment_id: delivery.comment_id,
          revision_id: delivery.revision_id,
        }))
        .sort((left, right) => String(left.kind).localeCompare(String(right.kind))),
      [
        { kind: 'comment', comment_id: created.id, revision_id: null },
        {
          kind: 'revision',
          comment_id: null,
          revision_id: published.revision.id,
        },
      ],
    );
  } finally {
    sqlite.close();
  }
});

void test('revogação durante envio de revisão vence o ACK tardio e o regrant', async () => {
  const { sqlite, db, owner, guest, document } = await fixture();
  try {
    await comment(guest, document.id, 'Crítica anterior');
    const published = await revision(owner, document.id);
    await db
      .prepare("UPDATE notification_deliveries SET status='sent' WHERE event_id NOT LIKE 'revision:%'")
      .run();
    let release!: (value: NotificationSendResult) => void;
    const held = new Promise<NotificationSendResult>((resolve) => {
      release = resolve;
    });
    const transport = new ControlledTransport();
    transport.send = () => held;
    const draining = drainNotifications(env(db), { transport });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      (await rows(db)).find((row) => row.revision_id === published.revision.id)
        ?.status,
      'leased',
    );

    await owner.revoke(document.id, guest.viewer.email);
    release({ providerId: 'accepted-after-revocation' });
    const result = await draining;
    const suppressed = (await rows(db)).find(
      (row) => row.revision_id === published.revision.id,
    );
    assert.equal(result.suppressed, 1);
    assert.equal(suppressed?.status, 'suppressed');
    assert.equal(suppressed?.provider_id, null);

    await owner.share(document.id, {
      email: guest.viewer.email,
      name: guest.viewer.name,
    });
    const afterRegrant = new ControlledTransport();
    assert.equal(
      (await drainNotifications(env(db), { transport: afterRegrant })).examined,
      0,
    );
    assert.equal(afterRegrant.messages.length, 0);
  } finally {
    sqlite.close();
  }
});

void test('evento persistido é imutável e exige destino exclusivo', async () => {
  const { sqlite, owner, guest, document } = await fixture();
  try {
    const created = await comment(guest, document.id, 'Crítica');
    assert.throws(
      () =>
        sqlite
          .prepare("UPDATE notification_events SET kind='revision' WHERE id=?")
          .run(created.id),
      /notification events are immutable/,
    );
    assert.throws(
      () => sqlite.prepare('DELETE FROM notification_events WHERE id=?').run(created.id),
      /notification events are immutable/,
    );
    assert.throws(
      () =>
        sqlite
          .prepare(
            `INSERT INTO notification_events
             (id,kind,comment_id,revision_id,document_id,root_id,actor_id,created_at)
             VALUES(?,?,?,?,?,?,?,?)`,
          )
          .run(
            'invalid-target',
            'revision',
            created.id,
            document.id,
            document.id,
            created.id,
            owner.viewer.id,
            new Date().toISOString(),
          ),
      /notification_events_target/,
    );
  } finally {
    sqlite.close();
  }
});

void test('retry preserva chave e payload privados após falha incerta e mudança de configuração', async () => {
  const { sqlite, db, guest, document } = await fixture();
  try {
    const created = await comment(
      guest,
      document.id,
      'Corpo secreto da crítica',
    );
    let clock = Math.floor(Date.now() / 1000) + 2;
    const transport = new ControlledTransport();
    transport.send = async () => {
      throw new NotificationSendError('provider_network', true, true);
    };
    const options: NotificationDrainOptions = { transport, now: () => clock };
    assert.equal((await drainNotifications(env(db), options)).retried, 1);
    const first = transport.messages[0];
    assert.ok(first);
    assert.equal(
      first.idempotencyKey.startsWith('comment-notification/'),
      true,
    );
    assert.equal(first.payload.includes(created.id), true);
    assert.equal(first.payload.includes('Corpo secreto'), false);
    assert.equal(first.payload.includes('Título que não pode vazar'), false);
    assert.equal(first.payload.includes('Convidado privado'), false);

    const persisted = (await rows(db))[0];
    clock = Number(persisted.available_at);
    transport.send = async () => ({ providerId: 'accepted-after-restart' });
    const changed = {
      ...env(db),
      APP_ORIGIN: 'https://changed.example',
      MAIL_FROM: 'Changed <changed@example.com>',
    };
    assert.equal((await drainNotifications(changed, options)).sent, 1);
    assert.equal(transport.messages[1]?.idempotencyKey, first.idempotencyKey);
    assert.equal(transport.messages[1]?.payload, first.payload);
    assert.equal((await rows(db))[0]?.provider_id, 'accepted-after-restart');
  } finally {
    sqlite.close();
  }
});

void test('429 conta Retry-After desde a resposta e não apaga incerteza anterior', async () => {
  const { sqlite, db, guest, document } = await fixture();
  try {
    await comment(guest, document.id, 'Crítica');
    let clock = Math.floor(Date.now() / 1000) + 2;
    const transport = new ControlledTransport();
    transport.send = async () => {
      clock += 20;
      throw new NotificationSendError('provider_rate_limit', true, false, 120);
    };
    await drainNotifications(env(db), { transport, now: () => clock });
    const first = (await rows(db))[0];
    assert.equal(first?.available_at, clock + 120);
    assert.equal(first?.uncertain, 0);

    await db
      .prepare(
        `UPDATE notification_deliveries SET status='pending',available_at=?,uncertain=1`,
      )
      .bind(clock)
      .run();
    await drainNotifications(env(db), { transport, now: () => clock });
    assert.equal((await rows(db))[0]?.uncertain, 1);
  } finally {
    sqlite.close();
  }
});

void test('revalida janela e lease depois de um claim lento antes do transporte', async () => {
  const { sqlite, db, guest, document } = await fixture();
  try {
    await comment(guest, document.id, 'Crítica');
    const initial = (await rows(db))[0];
    const firstAttempt = Math.floor(Date.now() / 1000) - 100;
    let clock = firstAttempt + 24 * 60 * 60 - 15 - 1;
    await db
      .prepare(
        `UPDATE notification_deliveries SET status='pending',available_at=0,
           attempts=1,first_attempt_at=?,uncertain=1,idempotency_key=?,payload=?
         WHERE id=?`,
      )
      .bind(
        firstAttempt,
        `comment-notification/${String(initial.id)}`,
        JSON.stringify({
          from: 'Avisos <notices@example.com>',
          to: [initial.recipient_email],
          subject: 'Nova crítica em um plano compartilhado',
          text: `http://127.0.0.1:3999/d/${document.id}?comment=${String(initial.comment_id)}`,
        }),
        initial.id,
      )
      .run();
    const delayed = Object.create(db) as D1Database;
    delayed.prepare = (sql: string) => {
      const statement = db.prepare(sql);
      if (!sql.includes("SET status='leased'")) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async first<T>() {
              const claimed = await bound.first<T>();
              clock += 20;
              return claimed;
            },
          };
        },
      } as unknown as D1PreparedStatement;
    };
    const transport = new ControlledTransport();
    const result = await drainNotifications(env(delayed), {
      transport,
      now: () => clock,
    });
    assert.equal(result.blocked, 1);
    assert.equal(transport.messages.length, 0);
    assert.equal((await rows(db))[0]?.status, 'blocked');
    assert.equal(
      (await rows(db))[0]?.last_error_code,
      'uncertain_window_elapsed',
    );
  } finally {
    sqlite.close();
  }
});

void test('lease expirado permite retomada e resultado tardio não sobrescreve o novo dono', async () => {
  const { sqlite, db, guest, document } = await fixture();
  try {
    await comment(guest, document.id, 'Crítica');
    let clock = Math.floor(Date.now() / 1000) + 2;
    let release!: (value: NotificationSendResult) => void;
    const held = new Promise<NotificationSendResult>((resolve) => {
      release = resolve;
    });
    const firstTransport = new ControlledTransport();
    firstTransport.send = () => held;
    const firstDrain = drainNotifications(env(db), {
      transport: firstTransport,
      now: () => clock,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await rows(db))[0]?.status, 'leased');

    clock += 16;
    const secondTransport = new ControlledTransport();
    secondTransport.send = async () => ({ providerId: 'lease-b' });
    assert.equal(
      (
        await drainNotifications(env(db), {
          transport: secondTransport,
          now: () => clock,
        })
      ).sent,
      1,
    );
    release({ providerId: 'late-lease-a' });
    await firstDrain;
    const delivery = (await rows(db))[0];
    assert.equal(delivery?.provider_id, 'lease-b');
    assert.equal(
      firstTransport.messages[0]?.idempotencyKey,
      secondTransport.messages[0]?.idempotencyKey,
    );
  } finally {
    sqlite.close();
  }
});

void test('revogação suprime pending ou leased e regrant não ressuscita geração antiga', async () => {
  const { sqlite, db, owner, guest, document } = await fixture();
  try {
    const root = await comment(guest, document.id, 'Raiz');
    await comment(owner, document.id, 'Resposta para guest', root.id);
    const guestDelivery = (await rows(db)).find(
      (row) => row.recipient_id === 'guest',
    );
    assert.ok(guestDelivery);
    await owner.revoke(document.id, guest.viewer.email);
    assert.equal(
      (await rows(db)).find((row) => row.id === guestDelivery.id)?.status,
      'suppressed',
    );
    await owner.share(document.id, {
      email: guest.viewer.email,
      name: 'Guest',
    });
    const transport = new ControlledTransport();
    await drainNotifications(env(db), { transport });
    assert.equal(
      transport.messages.some((message) =>
        message.payload.includes(guest.viewer.email),
      ),
      false,
    );
  } finally {
    sqlite.close();
  }
});

void test('janela incerta bloqueia e reconciliação idempotente preserva gerações', async () => {
  const { sqlite, db, guest, document } = await fixture();
  try {
    await comment(guest, document.id, 'Crítica');
    const initial = (await rows(db))[0];
    const firstAttempt = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    await db
      .prepare(
        `UPDATE notification_deliveries SET status='pending',available_at=0,
           attempts=1,first_attempt_at=?,uncertain=1,idempotency_key=?,payload=? WHERE id=?`,
      )
      .bind(
        firstAttempt,
        `comment-notification/${String(initial.id)}`,
        JSON.stringify({
          from: 'Avisos <notices@example.com>',
          to: [initial.recipient_email],
          subject: 'Nova crítica em um plano compartilhado',
          text: `http://127.0.0.1:3999/d/${document.id}?comment=${String(initial.comment_id)}`,
        }),
        initial.id,
      )
      .run();
    const transport = new ControlledTransport();
    assert.equal((await drainNotifications(env(db), { transport })).blocked, 1);
    assert.equal(transport.messages.length, 0);

    const actionId = crypto.randomUUID();
    const input = {
      actionId,
      deliveryId: String(initial.id),
      operatorId: 'operator@example.com',
      evidence: 'confirmed_not_delivered' as const,
      note: 'Provider support confirmed that no message was accepted.',
    };
    const action = await reconcileNotification(db, input);
    const replay = await reconcileNotification(db, input);
    assert.deepEqual(replay, action);
    assert.ok(action.result_delivery_id);
    const generations = await inspectNotifications(db, { status: 'all' });
    assert.equal(generations.deliveries.length, 2);
    assert.deepEqual(
      generations.deliveries.map((row) => row.status as string).sort(),
      ['pending', 'reconciled_not_delivered'],
    );
    await assert.rejects(
      reconcileNotification(db, { ...input, note: 'Different evidence.' }),
      /different evidence/,
    );

    await db
      .prepare(
        `UPDATE notification_deliveries SET status='blocked',uncertain=0,
           last_error_code='provider_rejected' WHERE id=?`,
      )
      .bind(action.result_delivery_id)
      .run();
    const safeRejection = await reconcileNotification(db, {
      ...input,
      actionId: crypto.randomUUID(),
      deliveryId: action.result_delivery_id!,
      note: 'Provider response proved that this generation was rejected.',
    });
    assert.ok(safeRejection.result_delivery_id);
    assert.equal(
      (await inspectNotifications(db, { status: 'all' })).deliveries.length,
      3,
    );
  } finally {
    sqlite.close();
  }
});

void test('reconciliação aceita confirmação externa e rollback não deixa ação sem geração', async () => {
  const { sqlite, db, guest, document } = await fixture();
  try {
    await comment(guest, document.id, 'Confirmação aceita');
    const acceptedDelivery = (await rows(db))[0];
    await db
      .prepare(
        `UPDATE notification_deliveries SET status='blocked',uncertain=1,
           last_error_code='uncertain_timeout' WHERE id=?`,
      )
      .bind(acceptedDelivery.id)
      .run();
    const accepted = await reconcileNotification(db, {
      actionId: crypto.randomUUID(),
      deliveryId: String(acceptedDelivery.id),
      operatorId: 'provider-support',
      evidence: 'accepted',
      providerId: 'provider-confirmed-id',
      note: 'Provider support confirmed acceptance.',
    });
    assert.equal(accepted.provider_id, 'provider-confirmed-id');
    const acceptedRow = (await rows(db))[0];
    assert.equal(acceptedRow?.status, 'sent');
    assert.equal(acceptedRow?.provider_id, 'provider-confirmed-id');

    await comment(guest, document.id, 'Confirmação de não entrega');
    const blocked = (await rows(db)).find((row) => row.status === 'pending');
    assert.ok(blocked);
    await db
      .prepare(
        `UPDATE notification_deliveries SET status='blocked',uncertain=1,
           last_error_code='uncertain_timeout' WHERE id=?`,
      )
      .bind(blocked.id)
      .run();
    sqlite.exec(`CREATE TRIGGER fail_retry_generation
      BEFORE INSERT ON notification_deliveries
      FOR EACH ROW WHEN NEW.retry_of_id IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'synthetic generation failure'); END;`);
    const actionId = crypto.randomUUID();
    await assert.rejects(
      reconcileNotification(db, {
        actionId,
        deliveryId: String(blocked.id),
        operatorId: 'provider-support',
        evidence: 'confirmed_not_delivered',
        note: 'Provider support confirmed rejection.',
      }),
      /synthetic generation failure/,
    );
    assert.equal(
      (
        await db
          .prepare(
            `SELECT count(*) AS count FROM notification_reconciliations
             WHERE action_id=?`,
          )
          .bind(actionId)
          .first<{ count: number }>()
      )?.count,
      0,
    );
    assert.equal(
      (await rows(db)).find((row) => row.id === blocked.id)?.status,
      'blocked',
    );
  } finally {
    sqlite.close();
  }
});

void test('lease ativo recusa reconciliação e ações concorrentes criam uma geração', async () => {
  const { sqlite, db, guest, document } = await fixture();
  try {
    await comment(guest, document.id, 'Conciliação concorrente');
    const delivery = (await rows(db))[0];
    await db
      .prepare(
        `UPDATE notification_deliveries SET status='leased',lease_token='active',
           lease_expires_at=?,uncertain=1 WHERE id=?`,
      )
      .bind(Math.floor(Date.now() / 1000) + 60, delivery.id)
      .run();
    await assert.rejects(
      reconcileNotification(db, {
        actionId: crypto.randomUUID(),
        deliveryId: String(delivery.id),
        operatorId: 'provider-support',
        evidence: 'accepted',
        providerId: 'provider-id',
        note: 'Provider support confirmed acceptance.',
      }),
      /not reconcilable/,
    );

    await db
      .prepare(
        `UPDATE notification_deliveries SET status='blocked',lease_token=NULL,
           lease_expires_at=NULL WHERE id=?`,
      )
      .bind(delivery.id)
      .run();
    const common = {
      deliveryId: String(delivery.id),
      operatorId: 'provider-support',
      evidence: 'confirmed_not_delivered' as const,
      note: 'Provider support confirmed rejection.',
    };
    const outcomes = await Promise.allSettled([
      reconcileNotification(db, {
        ...common,
        actionId: crypto.randomUUID(),
      }),
      reconcileNotification(db, {
        ...common,
        actionId: crypto.randomUUID(),
      }),
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === 'rejected').length,
      1,
    );
    assert.equal(
      (
        await db
          .prepare(
            `SELECT count(*) AS count FROM notification_deliveries
             WHERE retry_of_id=?`,
          )
          .bind(delivery.id)
          .first<{ count: number }>()
      )?.count,
      1,
    );
  } finally {
    sqlite.close();
  }
});

void test('inspeção pagina todos os bloqueios com cursor limitado', async () => {
  const { sqlite, db, guest, document } = await fixture();
  try {
    for (let index = 0; index < 101; index += 1)
      await comment(guest, document.id, `Crítica ${index}`);
    await db
      .prepare(
        `UPDATE notification_deliveries SET status='blocked',
           last_error_code='provider_rejected'`,
      )
      .run();

    const first = await inspectNotifications(db, {
      status: 'blocked',
      limit: 100,
    });
    assert.equal(first.deliveries.length, 100);
    assert.ok(first.nextCursor);
    const second = await inspectNotifications(db, {
      status: 'blocked',
      limit: 100,
      cursor: first.nextCursor!,
    });
    assert.equal(second.deliveries.length, 1);
    assert.equal(second.nextCursor, null);
    assert.equal(
      new Set([...first.deliveries, ...second.deliveries].map((row) => row.id))
        .size,
      101,
    );
  } finally {
    sqlite.close();
  }
});

void test('modo de teste não drena avisos de identidades antigas', async () => {
  const { sqlite, db, guest, document } = await fixture();
  try {
    await comment(guest, document.id, 'Crítica');
    const transport = new ControlledTransport();
    const result = await drainNotifications(
      { ...env(db), ACCESS_MODE: 'test' },
      { transport },
    );
    assert.equal(result.examined, 0);
    assert.equal(transport.messages.length, 0);
    assert.equal((await rows(db))[0]?.status, 'pending');
  } finally {
    sqlite.close();
  }
});

void test('transporte Resend exige id válido e classifica rate limit e incerteza', async () => {
  const message = {
    idempotencyKey: 'comment-notification/delivery',
    payload: '{"fixed":true}',
  };
  let captured: { url?: string; options?: RequestInit } = {};
  const accepted = new ResendNotificationTransport(
    're_synthetic',
    async (url, options) => {
      captured = {
        url:
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
        options,
      };
      return Response.json({ id: 'provider-id' }, { status: 200 });
    },
  );
  assert.deepEqual(await accepted.sendNotification(message), {
    providerId: 'provider-id',
  });
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.equal(captured.options?.body, message.payload);
  assert.equal(
    new Headers(captured.options?.headers).get('Idempotency-Key'),
    message.idempotencyKey,
  );

  const limited = new ResendNotificationTransport('re_synthetic', async () =>
    Response.json(
      { name: 'rate_limit_exceeded' },
      { status: 429, headers: { 'Retry-After': '123' } },
    ),
  );
  await assert.rejects(limited.sendNotification(message), (error: unknown) => {
    assert.ok(error instanceof NotificationSendError);
    assert.equal(error.code, 'provider_rate_limit');
    assert.equal(error.retryAfterSeconds, 123);
    assert.equal(error.uncertain, false);
    return true;
  });

  const invalidSuccess = new ResendNotificationTransport(
    're_synthetic',
    async () => Response.json({}, { status: 200 }),
  );
  await assert.rejects(
    invalidSuccess.sendNotification(message),
    (error: unknown) =>
      error instanceof NotificationSendError && error.uncertain,
  );
  const whitespaceId = new ResendNotificationTransport(
    're_synthetic',
    async () => Response.json({ id: '   ' }, { status: 200 }),
  );
  await assert.rejects(
    whitespaceId.sendNotification(message),
    (error: unknown) =>
      error instanceof NotificationSendError &&
      error.code === 'provider_invalid_response' &&
      error.uncertain,
  );

  const rejected = new ResendNotificationTransport('re_synthetic', async () =>
    Response.json({ name: 'validation_error' }, { status: 422 }),
  );
  await assert.rejects(rejected.sendNotification(message), (error: unknown) => {
    assert.ok(error instanceof NotificationSendError);
    assert.equal(error.code, 'provider_rejected');
    assert.equal(error.retryable, false);
    assert.equal(error.uncertain, false);
    return true;
  });

  const unknownConflict = new ResendNotificationTransport(
    're_synthetic',
    async () => Response.json({}, { status: 409 }),
  );
  await assert.rejects(
    unknownConflict.sendNotification(message),
    (error: unknown) =>
      error instanceof NotificationSendError &&
      error.code === 'provider_conflict' &&
      error.uncertain,
  );
});
