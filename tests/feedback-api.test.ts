import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../lib/api-handler.ts';
import { database, TestMailbox } from './fixture.ts';

const origin = 'https://docs.example.com';

type Credential = {
  id: string;
  name: string;
  scope: 'publish' | 'plan_read' | 'plan_revise';
  document_id: string | null;
  document_title: string | null;
  created_at: string;
  expires_at: number;
  revoked_at: number | null;
};

function fixture() {
  const { db, sqlite } = database();
  const mailbox = new TestMailbox();
  const values: Cloudflare.Env = {
    DB: db,
    APP_ORIGIN: origin,
    APP_OWNER_EMAIL: 'owner@example.com',
    APP_AUTHOR_EMAILS: 'guest@example.com',
  };
  function call(
    path: string,
    method = 'GET',
    input?: unknown,
    cookie = '',
    headers: Record<string, string> = {},
    environment = values,
  ) {
    return handleApi(
      new Request(`${origin}/api/${path}`, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          'Content-Type': 'application/json',
          ...headers,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(input ?? {}) }),
      }),
      environment,
      mailbox,
    );
  }
  async function login(email = 'owner@example.com') {
    assert.equal((await call('auth/request', 'POST', { email })).status, 200);
    const response = await call('auth/verify', 'POST', {
      token: mailbox.lastToken(),
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  async function credential(cookie: string, input: Record<string, unknown>) {
    const response = await call('publishing-tokens', 'POST', input, cookie);
    assert.equal(response.status, 201);
    return response.json() as Promise<{
      viewerId: string;
      token: string;
      credential: Credential;
    }>;
  }
  function agent(
    path: string,
    token: string,
    cookie = '',
    environment = values,
  ) {
    return call(
      path,
      'GET',
      undefined,
      cookie,
      {
        Authorization: `Bearer ${token}`,
      },
      environment,
    );
  }
  return { db, sqlite, values, call, login, credential, agent };
}

function interceptRevisionInsert(
  db: D1Database,
  mutation: (phase: 'before' | 'after') => void,
  phase: 'before' | 'after' = 'before',
) {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'prepare')
        return Reflect.get(target, property, receiver);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes('INSERT INTO document_revisions')) return statement;
        return new Proxy(statement, {
          get(prepared, preparedProperty, preparedReceiver) {
            if (preparedProperty !== 'bind')
              return Reflect.get(prepared, preparedProperty, preparedReceiver);
            return (...values: unknown[]) => {
              const bound = prepared.bind(...values);
              return new Proxy(bound, {
                get(final, finalProperty, finalReceiver) {
                  if (finalProperty !== 'run')
                    return Reflect.get(final, finalProperty, finalReceiver);
                  return async <T>() => {
                    if (phase === 'before') mutation('before');
                    const result = await final.run<T>();
                    if (phase === 'after') mutation('after');
                    return result;
                  };
                },
              });
            };
          },
        });
      };
    },
  }) as D1Database;
}

function uuid(index: number, version = 4) {
  return `10000000-0000-${version}000-8000-${index.toString(16).padStart(12, '0')}`;
}

async function createPlan(f: ReturnType<typeof fixture>, cookie: string) {
  const publish = await f.credential(cookie, { name: 'Publicação inicial' });
  const response = await f.call(
    'publications',
    'POST',
    {
      markdown: '\uFEFF# Plano inicial\r\n\r\nLinha com ç.\r\n',
      filename: 'plano.md',
      title: 'Plano inicial',
    },
    '',
    {
      Authorization: `Bearer ${publish.token}`,
      'Idempotency-Key': crypto.randomUUID(),
    },
  );
  assert.equal(response.status, 201);
  const publication = (await response.json()) as { documentId: string };
  return { documentId: publication.documentId, publish };
}

async function seedFeedback(
  f: ReturnType<typeof fixture>,
  documentId: string,
  ownerCookie: string,
) {
  const owner = f.sqlite
    .prepare('SELECT owner_id FROM documents WHERE id=?')
    .get(documentId) as { owner_id: string };
  const guestCookie = await f.login('guest@example.com');
  const guest = f.sqlite
    .prepare(
      'SELECT user_id FROM sessions WHERE token_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1',
    )
    .get() as { user_id: string };
  f.sqlite
    .prepare(
      'INSERT INTO shares(document_id,email,name,created_at) VALUES(?,?,?,?)',
    )
    .run(
      documentId,
      'guest@example.com',
      'Convidada',
      new Date().toISOString(),
    );
  const rootId = uuid(1, 7);
  const insertComment = f.sqlite.prepare(
    `INSERT INTO comments(
      id,document_id,author_id,body,quote,source_start,source_revision_id,root_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
  );
  for (let index = 1; index <= 55; index += 1) {
    const id = index === 1 ? rootId : uuid(index, index === 2 ? 7 : 4);
    insertComment.run(
      id,
      documentId,
      index % 2 === 0 ? owner.owner_id : guest.user_id,
      `Comentário ${index}`,
      index === 1 ? 'Plano inicial' : '',
      index === 1 ? 2 : null,
      documentId,
      null,
      new Date(Date.UTC(2026, 8, 11, 0, 0, index)).toISOString(),
    );
  }
  insertComment.run(
    uuid(56),
    documentId,
    guest.user_id,
    'Resposta com raiz na página anterior',
    '',
    null,
    documentId,
    rootId,
    new Date(Date.UTC(2026, 8, 11, 0, 1, 0)).toISOString(),
  );

  const insertEvent = f.sqlite.prepare(
    `INSERT INTO conversation_events(
      id,document_id,root_id,actor_id,base_version,version,action,state,
      decision,decision_reason,reason,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let version = 1; version <= 55; version += 1) {
    const decision = version % 3 === 0 ? 'follow' : null;
    insertEvent.run(
      uuid(100 + version, version === 55 ? 7 : 4),
      documentId,
      rootId,
      owner.owner_id,
      version - 1,
      version,
      decision ?? (version % 2 === 0 ? 'close' : 'reopen'),
      version % 2 === 0 ? 'closed' : 'open',
      decision,
      decision ? `Decisão ${version}` : null,
      decision ? null : `Motivo ${version}`,
      new Date(Date.UTC(2026, 8, 11, 1, 0, version)).toISOString(),
    );
  }

  const current = f.sqlite
    .prepare('SELECT current_revision_id FROM documents WHERE id=?')
    .get(documentId) as { current_revision_id: string };
  const revisionId = crypto.randomUUID();
  const revision = await f.call(
    `documents/${documentId}/revisions`,
    'POST',
    {
      id: revisionId,
      baseRevisionId: current.current_revision_id,
      markdown: '# Plano revisto\n\nConteúdo novo.\n',
      filename: 'plano-v2.md',
      title: 'Plano revisto',
      summary: 'Considera o primeiro comentário.',
      consideredCommentIds: [rootId],
    },
    ownerCookie,
  );
  assert.equal(revision.status, 201);
  assert.ok(guestCookie);
  return { rootId, revisionId };
}

void test('credenciais distinguem publicação e leitura vinculada sem elevar legados', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const ownerCookie = await f.login();
  const { documentId, publish } = await createPlan(f, ownerCookie);
  assert.deepEqual(
    {
      scope: publish.credential.scope,
      document: publish.credential.document_id,
    },
    { scope: 'publish', document: null },
  );
  const reader = await f.credential(ownerCookie, {
    name: 'Leitura do plano',
    scope: 'plan_read',
    documentId,
  });
  assert.equal(reader.credential.scope, 'plan_read');
  assert.equal(reader.credential.document_id, documentId);
  assert.equal(reader.credential.document_title, 'Plano inicial');

  const listed = (await (
    await f.call('publishing-tokens', 'GET', undefined, ownerCookie)
  ).json()) as { viewerId: string; credentials: Credential[] };
  assert.equal(listed.viewerId, reader.viewerId);
  assert.deepEqual(
    new Set(listed.credentials.map((entry) => entry.scope)),
    new Set(['publish', 'plan_read']),
  );
  assert.equal(
    (await f.agent(`agent/documents/${documentId}/feedback`, publish.token))
      .status,
    401,
  );
  assert.equal(
    (
      await f.call(
        'publications',
        'POST',
        { markdown: '# Negado', filename: 'negado.md' },
        '',
        {
          Authorization: `Bearer ${reader.token}`,
          'Idempotency-Key': 'reader-cannot-publish',
        },
      )
    ).status,
    401,
  );
  assert.throws(
    () =>
      f.sqlite
        .prepare('UPDATE publishing_tokens SET scope=? WHERE id=?')
        .run('publish', reader.credential.id),
    /scope target is immutable/,
  );
});

void test('manifesto, páginas e snapshots preservam feedback completo sob um selo', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const ownerCookie = await f.login();
  const { documentId } = await createPlan(f, ownerCookie);
  const { rootId, revisionId } = await seedFeedback(f, documentId, ownerCookie);
  const reader = await f.credential(ownerCookie, {
    name: 'Coleta completa',
    scope: 'plan_read',
    documentId,
  });
  const manifestResponse = await f.agent(
    `agent/documents/${documentId}/feedback`,
    reader.token,
  );
  assert.equal(manifestResponse.status, 200);
  const manifest = (await manifestResponse.json()) as {
    contract_version: number;
    document: {
      current_revision_id: string;
      current_revision_ordinal: number;
    };
    counts: { comments: number; events: number; revisions: number };
    stamp: string;
  };
  assert.equal(manifest.contract_version, 1);
  assert.equal(manifest.document.current_revision_id, revisionId);
  assert.equal(manifest.document.current_revision_ordinal, 2);
  assert.deepEqual(manifest.counts, { comments: 56, events: 55, revisions: 2 });

  const comments: Array<Record<string, unknown>> = [];
  let commentCursor: string | null = null;
  let firstCommentCursor: string | null = null;
  do {
    const parameters = new URLSearchParams({ stamp: manifest.stamp });
    if (commentCursor) parameters.set('cursor', commentCursor);
    const response = await f.agent(
      `agent/documents/${documentId}/feedback/comments?${parameters}`,
      reader.token,
    );
    assert.equal(response.status, 200);
    const page = (await response.json()) as {
      comments: Array<Record<string, unknown>>;
      next_cursor: string | null;
      stamp: string;
    };
    assert.equal(page.stamp, manifest.stamp);
    comments.push(...page.comments);
    commentCursor = page.next_cursor;
    firstCommentCursor ??= commentCursor;
  } while (commentCursor);
  assert.equal(comments.length, 56);
  assert.equal(new Set(comments.map((entry) => entry.id)).size, 56);
  const root = comments.find((entry) => entry.id === rootId)!;
  assert.deepEqual(root.conversation, {
    state: 'open',
    version: 55,
    decision: null,
    decision_reason: null,
    reply_count: 1,
  });
  const reply = comments.at(-1)!;
  assert.equal(reply.root_id, rootId);
  assert.equal(reply.is_root, false);
  assert.equal(reply.conversation, null);
  assert.ok(firstCommentCursor);
  assert.equal(
    (
      await f.agent(
        `agent/documents/${documentId}/feedback/events?stamp=${manifest.stamp}&cursor=${firstCommentCursor}`,
        reader.token,
      )
    ).status,
    400,
  );

  const events: Array<Record<string, unknown>> = [];
  let eventCursor: string | null = null;
  do {
    const parameters = new URLSearchParams({ stamp: manifest.stamp });
    if (eventCursor) parameters.set('cursor', eventCursor);
    const response = await f.agent(
      `agent/documents/${documentId}/feedback/events?${parameters}`,
      reader.token,
    );
    assert.equal(response.status, 200);
    const page = (await response.json()) as {
      events: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };
    events.push(...page.events);
    eventCursor = page.next_cursor;
  } while (eventCursor);
  assert.equal(events.length, 55);
  assert.equal(new Set(events.map((entry) => entry.id)).size, 55);

  const initial = (await (
    await f.agent(
      `agent/documents/${documentId}/revisions/${documentId}?stamp=${manifest.stamp}`,
      reader.token,
    )
  ).json()) as { revision: Record<string, unknown>; stamp: string };
  assert.equal(
    initial.revision.markdown,
    '\uFEFF# Plano inicial\r\n\r\nLinha com ç.\r\n',
  );
  assert.equal(initial.revision.ordinal, 1);
  assert.equal(initial.stamp, manifest.stamp);
  const current = (await (
    await f.agent(
      `agent/documents/${documentId}/revisions/${revisionId}?stamp=${manifest.stamp}`,
      reader.token,
    )
  ).json()) as { revision: { considered_comment_ids: string[] } };
  assert.deepEqual(current.revision.considered_comment_ids, [rootId]);
  const serialized = JSON.stringify({ manifest, comments, events, initial });
  assert.doesNotMatch(serialized, /"(?:email|token_hash|recipient_email)":/);
  assert.equal(
    (
      await f.agent(
        `agent/documents/${documentId}/feedback?stamp=${manifest.stamp}`,
        reader.token,
      )
    ).status,
    200,
  );
});

void test('snapshot aceita a mesma ordem binária de referências persistida pela revisão', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const ownerCookie = await f.login();
  const { documentId } = await createPlan(f, ownerCookie);
  const owner = f.sqlite
    .prepare('SELECT owner_id,current_revision_id FROM documents WHERE id=?')
    .get(documentId) as { owner_id: string; current_revision_id: string };
  const upperId = 'BBBBBBBB-0000-4000-8000-000000000001';
  const lowerId = 'aaaaaaaa-0000-7000-8000-000000000001';
  const insert = f.sqlite.prepare(
    `INSERT INTO comments(
      id,document_id,author_id,body,quote,source_start,source_revision_id,root_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
  );
  for (const [index, id] of [lowerId, upperId].entries())
    insert.run(
      id,
      documentId,
      owner.owner_id,
      `Referência ${index}`,
      '',
      null,
      owner.current_revision_id,
      null,
      new Date(Date.UTC(2026, 8, 11, 2, 0, index)).toISOString(),
    );
  const revisionId = crypto.randomUUID();
  assert.equal(
    (
      await f.call(
        `documents/${documentId}/revisions`,
        'POST',
        {
          id: revisionId,
          baseRevisionId: owner.current_revision_id,
          markdown: '# Ordem binária\n',
          filename: 'ordem.md',
          consideredCommentIds: [lowerId, upperId],
        },
        ownerCookie,
      )
    ).status,
    201,
  );
  const reader = await f.credential(ownerCookie, {
    name: 'Referências exatas',
    scope: 'plan_read',
    documentId,
  });
  const manifest = (await (
    await f.agent(`agent/documents/${documentId}/feedback`, reader.token)
  ).json()) as { stamp: string };
  const snapshot = await f.agent(
    `agent/documents/${documentId}/revisions/${revisionId}?stamp=${manifest.stamp}`,
    reader.token,
  );
  assert.equal(snapshot.status, 200);
  assert.deepEqual(
    (
      (await snapshot.json()) as {
        revision: { considered_comment_ids: string[] };
      }
    ).revision.considered_comment_ids,
    [upperId, lowerId],
  );
});

void test('vínculo, selo, cursores e revogação falham fechados sem fallback de sessão', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const ownerCookie = await f.login();
  const first = await createPlan(f, ownerCookie);
  const second = await createPlan(f, ownerCookie);
  const reader = await f.credential(ownerCookie, {
    name: 'Primeiro plano',
    scope: 'plan_read',
    documentId: first.documentId,
  });
  const otherReader = await f.credential(ownerCookie, {
    name: 'Outro token',
    scope: 'plan_read',
    documentId: first.documentId,
  });
  const manifest = (await (
    await f.agent(`agent/documents/${first.documentId}/feedback`, reader.token)
  ).json()) as { stamp: string };
  assert.equal(
    (
      await f.agent(
        `agent/documents/${first.documentId}/feedback?stamp=`,
        reader.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.agent(
        `agent/documents/${first.documentId}/feedback/comments?stamp=${manifest.stamp}&cursor=`,
        reader.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.agent(
        `agent/documents/${first.documentId}/feedback`,
        'mdp_' + '0'.repeat(64),
        ownerCookie,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.agent(
        `agent/documents/${second.documentId}/feedback`,
        reader.token,
        ownerCookie,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.agent(
        `agent/documents/${first.documentId}/feedback?stamp=${manifest.stamp}`,
        otherReader.token,
      )
    ).status,
    400,
  );
  const page = (await (
    await f.agent(
      `agent/documents/${first.documentId}/feedback/comments?stamp=${manifest.stamp}`,
      reader.token,
    )
  ).json()) as { next_cursor: string | null };
  assert.equal(page.next_cursor, null);

  f.sqlite
    .prepare(
      'INSERT INTO shares(document_id,email,name,created_at) VALUES(?,?,?,?)',
    )
    .run(
      first.documentId,
      'guest@example.com',
      'Convidada',
      new Date().toISOString(),
    );
  const guestCookie = await f.login('guest@example.com');
  assert.equal(
    (
      await f.call(
        'publishing-tokens',
        'POST',
        {
          name: 'Convite não basta',
          scope: 'plan_read',
          documentId: first.documentId,
        },
        guestCookie,
      )
    ).status,
    404,
  );

  f.sqlite
    .prepare('UPDATE publishing_tokens SET expires_at=0 WHERE id=?')
    .run(otherReader.credential.id);
  assert.equal(
    (
      await f.agent(
        `agent/documents/${first.documentId}/feedback`,
        otherReader.token,
      )
    ).status,
    401,
  );
  f.values.ACCESS_MODE = 'test';
  assert.equal(
    (
      await f.agent(
        `agent/documents/${first.documentId}/feedback`,
        reader.token,
      )
    ).status,
    404,
  );
  f.values.ACCESS_MODE = 'email';

  f.values.APP_OWNER_EMAIL = undefined;
  assert.equal(
    (
      await f.agent(
        `agent/documents/${first.documentId}/feedback?stamp=${manifest.stamp}`,
        reader.token,
      )
    ).status,
    200,
  );
  f.sqlite
    .prepare('UPDATE publishing_tokens SET revoked_at=1 WHERE id=?')
    .run(reader.credential.id);
  assert.equal(
    (
      await f.agent(
        `agent/documents/${first.documentId}/feedback`,
        reader.token,
        ownerCookie,
      )
    ).status,
    401,
  );
});

void test('mudança entre leitura e resposta invalida selo ou autorização', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const ownerCookie = await f.login();
  const { documentId } = await createPlan(f, ownerCookie);
  const reader = await f.credential(ownerCookie, {
    name: 'Concorrência',
    scope: 'plan_read',
    documentId,
  });
  const manifest = (await (
    await f.agent(`agent/documents/${documentId}/feedback`, reader.token)
  ).json()) as { stamp: string };
  const ownerId = (
    f.sqlite
      .prepare('SELECT owner_id FROM documents WHERE id=?')
      .get(documentId) as {
      owner_id: string;
    }
  ).owner_id;

  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reading = new Promise<void>((resolve) => (reached = resolve));
  const controlled = new Proxy(f.db, {
    get(target, property, receiver) {
      if (property !== 'prepare')
        return Reflect.get(target, property, receiver);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes('FROM comments c JOIN users u')) return statement;
        return new Proxy(statement, {
          get(prepared, preparedProperty, preparedReceiver) {
            if (preparedProperty !== 'bind')
              return Reflect.get(prepared, preparedProperty, preparedReceiver);
            return (...values: unknown[]) => {
              const bound = prepared.bind(...values);
              return new Proxy(bound, {
                get(final, finalProperty, finalReceiver) {
                  if (finalProperty !== 'all')
                    return Reflect.get(final, finalProperty, finalReceiver);
                  return async <T>() => {
                    reached();
                    await gate;
                    return final.all<T>();
                  };
                },
              });
            };
          },
        });
      };
    },
  }) as D1Database;
  const environment = { ...f.values, DB: controlled };
  const pending = f.agent(
    `agent/documents/${documentId}/feedback/comments?stamp=${manifest.stamp}`,
    reader.token,
    '',
    environment,
  );
  await reading;
  f.sqlite
    .prepare(
      `INSERT INTO comments(
        id,document_id,author_id,body,quote,source_start,source_revision_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?)`,
    )
    .run(
      crypto.randomUUID(),
      documentId,
      ownerId,
      'Mudança concorrente',
      '',
      null,
      documentId,
      new Date().toISOString(),
    );
  release();
  const changed = await pending;
  assert.equal(changed.status, 409);
  assert.equal(
    ((await changed.json()) as { code: string }).code,
    'feedback_changed',
  );

  const fresh = (await (
    await f.agent(`agent/documents/${documentId}/feedback`, reader.token)
  ).json()) as { stamp: string };
  let releaseRevocation!: () => void;
  let reachedRevocation!: () => void;
  const revocationGate = new Promise<void>(
    (resolve) => (releaseRevocation = resolve),
  );
  const revocationRead = new Promise<void>(
    (resolve) => (reachedRevocation = resolve),
  );
  const revokeControlled = new Proxy(f.db, {
    get(target, property, receiver) {
      if (property !== 'prepare')
        return Reflect.get(target, property, receiver);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes('FROM conversation_events e JOIN users u'))
          return statement;
        return new Proxy(statement, {
          get(prepared, preparedProperty, preparedReceiver) {
            if (preparedProperty !== 'bind')
              return Reflect.get(prepared, preparedProperty, preparedReceiver);
            return (...values: unknown[]) => {
              const bound = prepared.bind(...values);
              return new Proxy(bound, {
                get(final, finalProperty, finalReceiver) {
                  if (finalProperty !== 'all')
                    return Reflect.get(final, finalProperty, finalReceiver);
                  return async <T>() => {
                    reachedRevocation();
                    await revocationGate;
                    return final.all<T>();
                  };
                },
              });
            };
          },
        });
      };
    },
  }) as D1Database;
  const revokePending = f.agent(
    `agent/documents/${documentId}/feedback/events?stamp=${fresh.stamp}`,
    reader.token,
    '',
    { ...f.values, DB: revokeControlled },
  );
  await revocationRead;
  f.sqlite
    .prepare('UPDATE publishing_tokens SET revoked_at=1 WHERE id=?')
    .run(reader.credential.id);
  releaseRevocation();
  assert.equal((await revokePending).status, 401);
});

void test('plan_revise publica, relê recibo exato e preserva as permissões dos outros escopos', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const ownerCookie = await f.login();
  const { documentId, publish } = await createPlan(f, ownerCookie);
  const reader = await f.credential(ownerCookie, {
    name: 'Somente leitura',
    scope: 'plan_read',
    documentId,
  });
  const reviser = await f.credential(ownerCookie, {
    name: 'Republicação',
    scope: 'plan_revise',
    documentId,
  });
  assert.equal(reviser.credential.scope, 'plan_revise');
  assert.equal(reviser.credential.document_id, documentId);
  const other = await createPlan(f, ownerCookie);
  assert.equal(
    (
      await f.agent(
        `agent/documents/${other.documentId}/revisions/${other.documentId}`,
        reviser.token,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(
        `agent/documents/${other.documentId}/revisions`,
        'POST',
        {
          id: crypto.randomUUID(),
          baseRevisionId: other.documentId,
          markdown: '# Outro plano\n',
          filename: 'outro.md',
          consideredCommentIds: [],
        },
        '',
        { Authorization: `Bearer ${reviser.token}` },
      )
    ).status,
    401,
  );

  const current = f.sqlite
    .prepare('SELECT owner_id,current_revision_id FROM documents WHERE id=?')
    .get(documentId) as { owner_id: string; current_revision_id: string };
  const insertComment = f.sqlite.prepare(
    `INSERT INTO comments(
      id,document_id,author_id,body,quote,source_start,source_revision_id,root_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
  );
  const references = Array.from({ length: 100 }, (_, index) =>
    uuid(300 + index),
  );
  for (const [index, id] of references.entries())
    insertComment.run(
      id,
      documentId,
      current.owner_id,
      `Referência ${index + 1}`,
      '',
      null,
      current.current_revision_id,
      null,
      new Date(Date.UTC(2026, 8, 11, 4, 0, index)).toISOString(),
    );
  const revisionId = crypto.randomUUID();
  const request = {
    id: revisionId,
    baseRevisionId: current.current_revision_id,
    markdown: '# Revisão do agente\n\nConteúdo considerado.\n',
    filename: 'revisao-agente.md',
    title: 'Revisão do agente',
    summary: 'Considera cem referências exatas.',
    consideredCommentIds: [...references].reverse(),
  };
  const post = await f.call(
    `agent/documents/${documentId}/revisions`,
    'POST',
    request,
    '',
    { Authorization: `Bearer ${reviser.token}` },
  );
  assert.equal(post.status, 201);
  const receipt = (
    (await post.json()) as {
      revision: {
        id: string;
        ordinal: number;
        considered_comment_ids: string[];
        considered_comments: Array<{ id: string }>;
      };
    }
  ).revision;
  assert.equal(receipt.id, revisionId);
  assert.equal(receipt.ordinal, 2);
  assert.deepEqual(receipt.considered_comment_ids, [...references].sort());
  assert.deepEqual(
    receipt.considered_comments.map((comment) => comment.id),
    [...references].sort(),
  );
  assert.equal(
    (
      await f.call(
        `agent/documents/${documentId}/revisions`,
        'POST',
        request,
        '',
        { Authorization: `Bearer ${reviser.token}` },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        `agent/documents/${documentId}/revisions`,
        'POST',
        request,
        '',
        { Authorization: `Bearer ${reader.token}` },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(
        `agent/documents/${documentId}/revisions/${revisionId}`,
        'GET',
        undefined,
        '',
        { Authorization: `Bearer ${reader.token}` },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(
        `agent/documents/${documentId}/revisions/${revisionId}`,
        'GET',
        undefined,
        '',
        { Authorization: `Bearer ${publish.token}` },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(
        'publications',
        'POST',
        { markdown: '# Não permitido', filename: 'nao.md' },
        '',
        {
          Authorization: `Bearer ${reviser.token}`,
          'Idempotency-Key': 'revise-cannot-create-plan',
        },
      )
    ).status,
    401,
  );

  const manifest = (await (
    await f.agent(`agent/documents/${documentId}/feedback`, reviser.token)
  ).json()) as { stamp: string };
  assert.equal(
    (
      await f.agent(
        `agent/documents/${documentId}/revisions/${revisionId}?stamp=${manifest.stamp}`,
        reviser.token,
      )
    ).status,
    200,
  );
  const replacement = await f.credential(ownerCookie, {
    name: 'Republicação substituta',
    scope: 'plan_revise',
    documentId,
  });
  assert.equal(
    (
      await f.agent(
        `agent/documents/${documentId}/revisions/${revisionId}?stamp=${manifest.stamp}`,
        replacement.token,
      )
    ).status,
    400,
  );
  const exact = await f.agent(
    `agent/documents/${documentId}/revisions/${revisionId}`,
    replacement.token,
  );
  assert.equal(exact.status, 200);
  assert.deepEqual(
    ((await exact.json()) as { revision: unknown }).revision,
    receipt,
  );
  assert.equal(
    (
      await f.agent(
        `agent/documents/${documentId}/revisions/${crypto.randomUUID()}`,
        replacement.token,
      )
    ).status,
    404,
  );
  for (const suffix of ['?stamp=', '?cursor=', '?x=1', '?stamp=a&stamp=b'])
    assert.equal(
      (
        await f.agent(
          `agent/documents/${documentId}/revisions/${revisionId}${suffix}`,
          replacement.token,
        )
      ).status,
      400,
    );
});

void test('plan_revise exige canCreate no POST, mas mantém leitura do recibo sem essa capacidade', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const ownerCookie = await f.login();
  const { documentId } = await createPlan(f, ownerCookie);
  const reviser = await f.credential(ownerCookie, {
    name: 'Republicação controlada',
    scope: 'plan_revise',
    documentId,
  });
  const current = f.sqlite
    .prepare('SELECT current_revision_id FROM documents WHERE id=?')
    .get(documentId) as { current_revision_id: string };
  const request = {
    id: crypto.randomUUID(),
    baseRevisionId: current.current_revision_id,
    markdown: '# Segunda\n',
    filename: 'segunda.md',
    consideredCommentIds: [],
  };
  assert.equal(
    (
      await f.call(
        `agent/documents/${documentId}/revisions`,
        'POST',
        request,
        '',
        { Authorization: `Bearer ${reviser.token}` },
      )
    ).status,
    201,
  );
  f.values.APP_OWNER_EMAIL = undefined;
  assert.equal(
    (
      await f.call(
        `agent/documents/${documentId}/revisions`,
        'POST',
        request,
        '',
        { Authorization: `Bearer ${reviser.token}` },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.agent(
        `agent/documents/${documentId}/revisions/${request.id}`,
        reviser.token,
      )
    ).status,
    200,
  );
});

void test('guarda atômica de plan_revise bloqueia mudanças antes do INSERT e trata commit sem ACK como incerto', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const ownerCookie = await f.login();
  const { documentId } = await createPlan(f, ownerCookie);
  const reviser = await f.credential(ownerCookie, {
    name: 'Interleavings',
    scope: 'plan_revise',
    documentId,
  });
  const stored = f.sqlite
    .prepare(
      'SELECT token_hash,expires_at,user_id FROM publishing_tokens WHERE id=?',
    )
    .get(reviser.credential.id) as {
    token_hash: string;
    expires_at: number;
    user_id: string;
  };
  const currentRevision = () =>
    (
      f.sqlite
        .prepare('SELECT current_revision_id FROM documents WHERE id=?')
        .get(documentId) as { current_revision_id: string }
    ).current_revision_id;
  const payload = () => ({
    id: crypto.randomUUID(),
    baseRevisionId: currentRevision(),
    markdown: '# Concorrência\n',
    filename: 'concorrencia.md',
    consideredCommentIds: [],
  });
  const send = (input: ReturnType<typeof payload>, db: D1Database) =>
    f.call(
      `agent/documents/${documentId}/revisions`,
      'POST',
      input,
      '',
      { Authorization: `Bearer ${reviser.token}` },
      { ...f.values, DB: db },
    );
  const assertAbsent = (id: string) => {
    assert.equal(
      (
        f.sqlite
          .prepare(
            'SELECT count(*) AS count FROM document_revisions WHERE id=?',
          )
          .get(id) as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        f.sqlite
          .prepare(
            'SELECT count(*) AS count FROM notification_events WHERE revision_id=?',
          )
          .get(id) as { count: number }
      ).count,
      0,
    );
  };

  const mutations: Array<{
    mutate: () => void;
    restore: () => void;
  }> = [
    {
      mutate: () => {
        f.sqlite
          .prepare('UPDATE publishing_tokens SET revoked_at=1 WHERE id=?')
          .run(reviser.credential.id);
      },
      restore: () => {
        f.sqlite
          .prepare('UPDATE publishing_tokens SET revoked_at=NULL WHERE id=?')
          .run(reviser.credential.id);
      },
    },
    {
      mutate: () => {
        f.sqlite
          .prepare('UPDATE publishing_tokens SET expires_at=0 WHERE id=?')
          .run(reviser.credential.id);
      },
      restore: () => {
        f.sqlite
          .prepare('UPDATE publishing_tokens SET expires_at=? WHERE id=?')
          .run(stored.expires_at, reviser.credential.id);
      },
    },
    {
      mutate: () => {
        f.sqlite
          .prepare('UPDATE publishing_tokens SET token_hash=? WHERE id=?')
          .run('f'.repeat(64), reviser.credential.id);
      },
      restore: () => {
        f.sqlite
          .prepare('UPDATE publishing_tokens SET token_hash=? WHERE id=?')
          .run(stored.token_hash, reviser.credential.id);
      },
    },
  ];
  for (const entry of mutations) {
    const request = payload();
    const controlled = interceptRevisionInsert(f.db, entry.mutate);
    assert.equal((await send(request, controlled)).status, 401);
    assertAbsent(request.id);
    entry.restore();
  }

  const otherUserId = crypto.randomUUID();
  f.sqlite
    .prepare(`INSERT INTO users(id,email,name,test_email) VALUES(?,?,?,?)`)
    .run(otherUserId, 'other@example.com', 'Outra', null);
  const ownershipRequest = payload();
  const changedOwner = interceptRevisionInsert(f.db, () => {
    f.sqlite
      .prepare('UPDATE documents SET owner_id=? WHERE id=?')
      .run(otherUserId, documentId);
  });
  assert.equal((await send(ownershipRequest, changedOwner)).status, 401);
  assertAbsent(ownershipRequest.id);
  f.sqlite
    .prepare('UPDATE documents SET owner_id=? WHERE id=?')
    .run(stored.user_id, documentId);

  const committed = payload();
  const revokeAfterCommit = interceptRevisionInsert(
    f.db,
    () => {
      f.sqlite
        .prepare('UPDATE publishing_tokens SET revoked_at=1 WHERE id=?')
        .run(reviser.credential.id);
    },
    'after',
  );
  assert.equal((await send(committed, revokeAfterCommit)).status, 401);
  assert.equal(
    (
      f.sqlite
        .prepare('SELECT count(*) AS count FROM document_revisions WHERE id=?')
        .get(committed.id) as { count: number }
    ).count,
    1,
  );
  assert.equal(
    (
      f.sqlite
        .prepare(
          'SELECT count(*) AS count FROM notification_events WHERE revision_id=?',
        )
        .get(committed.id) as { count: number }
    ).count,
    1,
  );
  const replacement = await f.credential(ownerCookie, {
    name: 'Recuperação',
    scope: 'plan_revise',
    documentId,
  });
  assert.equal(
    (
      await f.agent(
        `agent/documents/${documentId}/revisions/${committed.id}`,
        replacement.token,
      )
    ).status,
    200,
  );
});
