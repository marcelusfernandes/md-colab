import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { handleApi } from '../lib/api-handler.ts';
import { database, TestMailbox } from './fixture.ts';

const origin = 'https://docs.example.com';

async function captureFailure(
  t: TestContext,
  run: () => Promise<Response>,
) {
  const original = console.error;
  const entries: unknown[][] = [];
  console.error = (...values: unknown[]) => entries.push(values);
  t.after(() => {
    console.error = original;
  });
  const response = await run();
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], 'api_failure');
  assert.equal(typeof entries[0][1], 'string');
  return {
    response,
    diagnostic: JSON.parse(entries[0][1] as string) as Record<string, unknown>,
    serialized: JSON.stringify(entries),
  };
}

void test('diagnóstico usa somente método, rota, categoria e status controlados', async (t) => {
  const { sqlite, db } = database();
  t.after(() => sqlite.close());
  const receivedId = 'received-id-123';
  const email = 'private@example.com';
  const cursor = 'cursor-secret';
  const { response, diagnostic, serialized } = await captureFailure(t, () =>
    handleApi(
      new Request(
        `${origin}/api/private/${receivedId}/${email}?cursor=${cursor}`,
        {
          method: 'PATCH',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token: 'body-secret' }),
        },
      ),
      { DB: db, APP_ORIGIN: origin },
      new TestMailbox(),
    ),
  );
  assert.equal(response.status, 401);
  const body = (await response.json()) as Record<string, unknown>;
  assert.match(body.requestId as string, /^[0-9a-f-]{36}$/);
  assert.deepEqual(diagnostic, {
    requestId: body.requestId,
    method: 'OTHER',
    route: 'unknown',
    category: 'unknown_route',
    status: 401,
  });
  for (const secret of [receivedId, email, cursor, 'body-secret'])
    assert.equal(serialized.includes(secret), false);
});

void test('falha interna não registra nome, mensagem, URL, query, e-mail ou corpo', async (t) => {
  const { sqlite, db } = database();
  t.after(() => sqlite.close());
  const secretName = 'SecretDatabaseFailure';
  const secretMessage = 'token=server-secret';
  const failingDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'prepare') return Reflect.get(target, property, receiver);
      return () => {
        const error = new Error(secretMessage);
        error.name = secretName;
        throw error;
      };
    },
  });
  const privateEmail = 'person@example.com';
  const { response, diagnostic, serialized } = await captureFailure(t, () =>
    handleApi(
      new Request(`${origin}/api/auth/request?cursor=query-secret`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: privateEmail }),
      }),
      { DB: failingDb, APP_ORIGIN: origin },
      new TestMailbox(),
    ),
  );
  assert.equal(response.status, 500);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.error, 'Não foi possível concluir. Tente novamente.');
  assert.match(body.requestId as string, /^[0-9a-f-]{36}$/);
  assert.deepEqual(diagnostic, {
    requestId: body.requestId,
    method: 'POST',
    route: 'auth',
    category: 'internal',
    status: 500,
  });
  for (const secret of [
    secretName,
    secretMessage,
    privateEmail,
    'query-secret',
    '/api/auth/request',
  ])
    assert.equal(serialized.includes(secret), false);
});

void test('resposta de cota expõe código estável e requestId igual ao diagnóstico', async (t) => {
  const { sqlite, db } = database();
  t.after(() => sqlite.close());
  const mailbox = new TestMailbox();
  const values: Cloudflare.Env = {
    DB: db,
    APP_ORIGIN: origin,
    ACCESS_MODE: 'test',
    MAX_OWNED_DOCUMENTS: '1',
  };
  const call = (path: string, input: unknown, cookie = '') =>
    handleApi(
      new Request(`${origin}/api/${path}`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify(input),
      }),
      values,
      mailbox,
    );
  const login = await call('auth/test', { email: 'test@example.com' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const sessionResponse = await handleApi(
    new Request(`${origin}/api/session`, { headers: { Cookie: cookie } }),
    values,
    mailbox,
  );
  const session = (await sessionResponse.json()) as {
    viewer: { id: string };
  };
  const document = (label: string) => ({
    id: crypto.randomUUID(),
    authorId: session.viewer.id,
    markdown: `# ${label}`,
    filename: `${label}.md`,
  });
  assert.equal((await call('documents', document('first'), cookie)).status, 201);
  const { response, diagnostic } = await captureFailure(t, () =>
    call('documents', document('second'), cookie),
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, 'quota_exceeded');
  assert.match(body.error as string, /limite total/i);
  assert.equal(body.requestId, diagnostic.requestId);
  assert.equal(diagnostic.route, 'documents');
  assert.equal(diagnostic.category, 'quota');
  assert.equal(diagnostic.status, 409);
});
