import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../lib/api-handler.ts';
import { AuthService, hashToken } from '../lib/auth-service.ts';
import {
  MAX_ACTIVE_PUBLISHING_TOKENS,
  PUBLISHING_TOKEN_SECONDS,
  PublicationService,
} from '../lib/publication-service.ts';
import { database, TestMailbox } from './fixture.ts';

const origin = 'https://docs.example.com';
type Credential = {
  id: string;
  name: string;
  created_at: string;
  expires_at: number;
  revoked_at: number | null;
};
type PublicationResult = {
  documentId: string;
  publicationId: string;
  url: string;
};

async function body<T>(response: Response) {
  return response.json() as Promise<T>;
}

function fixture() {
  const { db, sqlite } = database();
  const mailbox = new TestMailbox();
  const values: Cloudflare.Env = {
    DB: db,
    APP_ORIGIN: origin,
    APP_OWNER_EMAIL: 'owner@example.com',
    APP_AUTHOR_EMAILS: 'author@example.com',
  };
  function call(
    path: string,
    method = 'GET',
    input?: unknown,
    cookie = '',
    headers: Record<string, string> = {},
  ) {
    return handleApi(
      new Request(origin + '/api/' + path, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          'Content-Type': 'application/json',
          ...headers,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(input ?? {}) }),
      }),
      values,
      mailbox,
    );
  }
  async function login(email = 'owner@example.com') {
    assert.equal((await call('auth/request', 'POST', { email })).status, 200);
    const verified = await call('auth/verify', 'POST', {
      token: mailbox.lastToken(),
    });
    assert.equal(verified.status, 200);
    return verified.headers.get('set-cookie')!.split(';')[0];
  }
  async function createCredential(cookie: string, name = 'Notebook') {
    const response = await call('publishing-tokens', 'POST', { name }, cookie);
    assert.equal(response.status, 201);
    return body<{ token: string; credential: Credential }>(response);
  }
  function publish(
    token: string,
    key: string,
    input: Record<string, unknown> = {
      markdown: '# Plano\n\nTexto original.\n',
      filename: 'plano.md',
    },
    cookie = '',
  ) {
    return call('publications', 'POST', input, cookie, {
      Authorization: 'Bearer ' + token,
      'Idempotency-Key': key,
    });
  }
  return {
    db,
    sqlite,
    mailbox,
    values,
    call,
    login,
    createCredential,
    publish,
  };
}

void test('credencial nomeada mostra segredo uma vez, persiste somente hash e aplica expiração e limites', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const cookie = await f.login();
  const before = Math.floor(Date.now() / 1000);
  const created = await f.createCredential(cookie, 'Agente local');
  assert.match(created.token, /^mdp_[0-9a-f]{64}$/);
  assert.equal(created.credential.name, 'Agente local');
  assert.ok(created.credential.expires_at >= before + PUBLISHING_TOKEN_SECONDS);
  const stored = f.sqlite
    .prepare('SELECT token_hash FROM publishing_tokens WHERE id=?')
    .get(created.credential.id) as { token_hash: string };
  assert.notEqual(stored.token_hash, created.token);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(created.token));

  const listed = await body<{ credentials: Credential[] }>(
    await f.call('publishing-tokens', 'GET', undefined, cookie),
  );
  assert.deepEqual(listed.credentials, [created.credential]);
  assert.equal('token' in listed.credentials[0], false);
  assert.equal('token_hash' in listed.credentials[0], false);
  assert.equal(
    (
      await f.call(
        'publishing-tokens',
        'POST',
        { name: 'x'.repeat(81) },
        cookie,
      )
    ).status,
    400,
  );
  for (let index = 1; index < MAX_ACTIVE_PUBLISHING_TOKENS; index++)
    await f.createCredential(cookie, 'Credencial ' + index);
  assert.equal(
    (
      await f.call(
        'publishing-tokens',
        'POST',
        { name: 'Além do limite' },
        cookie,
      )
    ).status,
    409,
  );
});

void test('gestão usa cookie, isola autores e permite revogar após remover canCreate', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const ownerCookie = await f.login();
  const ownerToken = await f.createCredential(ownerCookie, 'Do dono');
  const published = await f.publish(ownerToken.token, 'before-removal');
  assert.equal(published.status, 201);
  const authorCookie = await f.login('author@example.com');
  assert.deepEqual(
    (
      await body<{ credentials: Credential[] }>(
        await f.call('publishing-tokens', 'GET', undefined, authorCookie),
      )
    ).credentials,
    [],
  );
  assert.equal(
    (
      await f.call(
        'publishing-tokens/' + ownerToken.credential.id,
        'DELETE',
        {},
        authorCookie,
      )
    ).status,
    404,
  );

  f.values.APP_OWNER_EMAIL = undefined;
  assert.equal(
    (await f.call('publishing-tokens', 'GET', undefined, ownerCookie)).status,
    200,
  );
  assert.equal(
    (await f.call('publishing-tokens', 'POST', { name: 'Negada' }, ownerCookie))
      .status,
    403,
  );
  assert.equal(
    (await f.publish(ownerToken.token, 'removed-author')).status,
    403,
  );
  assert.equal(
    (await f.publish(ownerToken.token, 'before-removal')).status,
    403,
  );
  const revoked = await f.call(
    'publishing-tokens/' + ownerToken.credential.id,
    'DELETE',
    {},
    ownerCookie,
  );
  assert.equal(revoked.status, 200);
  assert.equal(
    (await body<{ credential: Credential }>(revoked)).credential.revoked_at !==
      null,
    true,
  );
  assert.equal((await f.publish(ownerToken.token, 'revoked')).status, 401);
});

void test('Bearer autentica exclusivamente POST publications e nunca cai para cookie', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const cookie = await f.login();
  const credential = await f.createCredential(cookie);
  assert.equal(
    (
      await f.call('documents', 'GET', undefined, '', {
        Authorization: 'Bearer ' + credential.token,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call('publishing-tokens', 'GET', undefined, '', {
        Authorization: 'Bearer ' + credential.token,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(
        'publications',
        'POST',
        { markdown: '# Cookie', filename: 'cookie.md' },
        cookie,
        { 'Idempotency-Key': 'cookie-only' },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(
        'publications',
        'POST',
        { markdown: '# Cookie', filename: 'cookie.md' },
        cookie,
        {
          Authorization: 'Bearer mdp_' + '0'.repeat(64),
          'Idempotency-Key': 'invalid-with-cookie',
        },
      )
    ).status,
    401,
  );
  f.sqlite
    .prepare('UPDATE publishing_tokens SET expires_at=? WHERE id=?')
    .run(0, credential.credential.id);
  assert.equal((await f.publish(credential.token, 'expired')).status, 401);
});

void test('publicação preserva Markdown, limita contrato e retorna URL e IDs estáveis', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const credential = await f.createCredential(await f.login());
  const markdown = '\n# Título\n\n![referência](./imagem.png)\n';
  const response = await f.publish(credential.token, 'stable-1', {
    markdown,
    filename: ' plano.md ',
    title: 'Plano pela API',
  });
  assert.equal(response.status, 201);
  const result = await body<PublicationResult>(response);
  assert.match(result.documentId, /^[0-9a-f-]{36}$/i);
  assert.match(result.publicationId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.url, origin + '/d/' + result.documentId);
  const row = f.sqlite
    .prepare('SELECT markdown,filename,title,is_test FROM documents WHERE id=?')
    .get(result.documentId) as {
    markdown: string;
    filename: string;
    title: string;
    is_test: number;
  };
  assert.deepEqual(
    { ...row },
    {
      markdown,
      filename: 'plano.md',
      title: 'Plano pela API',
      is_test: 0,
    },
  );
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM shares').get()?.n, 0);
  assert.equal(
    (
      await f.publish(credential.token, 'extra-field', {
        markdown: '# X',
        filename: 'x.md',
        invitation: 'guest@example.com',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(
        'publications',
        'POST',
        { markdown: '# X', filename: 'x.md' },
        '',
        { Authorization: 'Bearer ' + credential.token },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.publish(credential.token, 'x'.repeat(129), {
        markdown: '# X',
        filename: 'x.md',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.publish(credential.token, 'too-large', {
        markdown: 'é'.repeat(600_000),
        filename: 'x.md',
      })
    ).status,
    413,
  );
});

void test('retry e concorrência retornam a mesma publicação com um único documento', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const credential = await f.createCredential(await f.login());
  const first = await f.publish(credential.token, 'concurrent-key');
  const expected = await body<PublicationResult>(first);
  const replay = await f.publish(credential.token, 'concurrent-key');
  assert.deepEqual(await body<PublicationResult>(replay), expected);

  const baseService = new PublicationService(f.db, {
    origin,
    ownerEmail: 'owner@example.com',
  });
  const identity = await baseService.authenticate(
    new Request(origin, {
      headers: { Authorization: 'Bearer ' + credential.token },
    }),
  );
  let initialSelects = 0;
  let releaseBarrier = () => {};
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const barrierDb = new Proxy(f.db, {
    get(target, property, receiver) {
      if (property !== 'prepare')
        return Reflect.get(target, property, receiver);
      return (sql: string) => {
        const prepared = target.prepare(sql);
        if (
          !sql.includes(
            'SELECT id,document_id,payload_digest FROM publications',
          )
        )
          return prepared;
        return new Proxy(prepared, {
          get(statement, statementProperty, statementReceiver) {
            if (statementProperty !== 'bind')
              return Reflect.get(
                statement,
                statementProperty,
                statementReceiver,
              );
            return (...values: (string | number | null)[]) => {
              const bound = statement.bind(...values);
              return new Proxy(bound, {
                get(boundStatement, boundProperty, boundReceiver) {
                  if (boundProperty !== 'first')
                    return Reflect.get(
                      boundStatement,
                      boundProperty,
                      boundReceiver,
                    );
                  return async () => {
                    if (initialSelects < 2) {
                      initialSelects += 1;
                      if (initialSelects === 2) releaseBarrier();
                      await barrier;
                    }
                    return boundStatement.first();
                  };
                },
              });
            };
          },
        });
      };
    },
  });
  const concurrentService = new PublicationService(barrierDb, {
    origin,
    ownerEmail: 'owner@example.com',
  });
  const concurrent = await Promise.all([
    concurrentService.publish(
      identity.viewer,
      identity.credentialId,
      { markdown: '# Concorrente', filename: 'concorrente.md' },
      'another-concurrent-key',
    ),
    concurrentService.publish(
      identity.viewer,
      identity.credentialId,
      { markdown: '# Concorrente', filename: 'concorrente.md' },
      'another-concurrent-key',
    ),
  ]);
  assert.equal(initialSelects, 2);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal(
    f.sqlite.prepare('SELECT count(*) n FROM publications').get()?.n,
    2,
  );
  assert.equal(
    f.sqlite.prepare('SELECT count(*) n FROM documents').get()?.n,
    2,
  );
});

void test('chave divergente retorna 409, outra conta permanece isolada e replay exige autenticação', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const ownerCredential = await f.createCredential(await f.login(), 'Owner');
  const first = await f.publish(ownerCredential.token, 'same-key', {
    markdown: '# Primeiro',
    filename: 'primeiro.md',
  });
  const firstResult = await body<PublicationResult>(first);
  assert.equal(
    (
      await f.publish(ownerCredential.token, 'same-key', {
        markdown: '# Alterado',
        filename: 'primeiro.md',
      })
    ).status,
    409,
  );
  assert.equal(
    f.sqlite
      .prepare('SELECT markdown FROM documents WHERE id=?')
      .get(firstResult.documentId)?.markdown,
    '# Primeiro',
  );

  const authorCredential = await f.createCredential(
    await f.login('author@example.com'),
    'Author',
  );
  assert.equal(
    (
      await f.publish(authorCredential.token, 'same-key', {
        markdown: '# Outro autor',
        filename: 'outro.md',
      })
    ).status,
    201,
  );
  f.sqlite
    .prepare('UPDATE publishing_tokens SET revoked_at=1 WHERE id=?')
    .run(ownerCredential.credential.id);
  assert.equal(
    (
      await f.publish(ownerCredential.token, 'same-key', {
        markdown: '# Primeiro',
        filename: 'primeiro.md',
      })
    ).status,
    401,
  );
});

void test('erro inesperado após batch confirmado não é convertido em replay', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const cookie = await f.login();
  const created = await f.createCredential(cookie);
  const auth = new AuthService(
    f.db,
    { origin, ownerEmail: 'owner@example.com' },
    f.mailbox,
  );
  const authenticated = await auth.viewer(
    new Request(origin + '/api/session', { headers: { Cookie: cookie } }),
  );
  assert.ok(authenticated);
  const realBatch = f.db.batch.bind(f.db);
  const ambiguousDb = new Proxy(f.db, {
    get(target, property, receiver) {
      if (property !== 'batch') return Reflect.get(target, property, receiver);
      return async (statements: D1PreparedStatement[]) => {
        await realBatch(statements);
        throw new Error('transport failed after commit');
      };
    },
  });
  const service = new PublicationService(ambiguousDb, {
    origin,
    ownerEmail: 'owner@example.com',
  });
  await assert.rejects(
    service.publish(
      authenticated,
      created.credential.id,
      { markdown: '# Ambíguo', filename: 'ambiguo.md' },
      'ambiguous-key',
    ),
    /transport failed after commit/,
  );
  assert.equal(
    f.sqlite.prepare('SELECT count(*) n FROM publications').get()?.n,
    1,
  );
});

void test('falha na inserção da publicação reverte o documento no mesmo batch', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const cookie = await f.login();
  const auth = new AuthService(
    f.db,
    { origin, ownerEmail: 'owner@example.com' },
    f.mailbox,
  );
  const viewer = await auth.viewer(
    new Request(origin, { headers: { Cookie: cookie } }),
  );
  assert.ok(viewer);
  const service = new PublicationService(f.db, {
    origin,
    ownerEmail: 'owner@example.com',
  });
  await assert.rejects(
    service.publish(
      viewer,
      crypto.randomUUID(),
      { markdown: '# Falha', filename: 'falha.md' },
      'rollback-key',
    ),
    /FOREIGN KEY constraint failed/,
  );
  assert.equal(
    f.sqlite.prepare('SELECT count(*) n FROM documents').get()?.n,
    0,
  );
  assert.equal(
    f.sqlite.prepare('SELECT count(*) n FROM publications').get()?.n,
    0,
  );
});

void test('modo de teste não emite, gerencia nem usa credenciais de publicação', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  f.values.ACCESS_MODE = 'test';
  const entered = await f.call('auth/test', 'POST', {
    email: 'declared@example.com',
  });
  const testCookie = entered.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await f.call('publishing-tokens', 'GET', undefined, testCookie)).status,
    404,
  );
  assert.equal(
    (await f.call('publishing-tokens', 'POST', { name: 'Teste' }, testCookie))
      .status,
    404,
  );
  assert.equal(
    (
      await f.call(
        'publications',
        'POST',
        { markdown: '# Teste', filename: 'teste.md' },
        testCookie,
        {
          Authorization: 'Bearer mdp_' + '0'.repeat(64),
          'Idempotency-Key': 'test-mode',
        },
      )
    ).status,
    404,
  );
  assert.equal(
    f.sqlite.prepare('SELECT count(*) n FROM publishing_tokens').get()?.n,
    0,
  );

  const testUser = f.sqlite
    .prepare('SELECT id FROM users WHERE test_email IS NOT NULL')
    .get() as { id: string };
  const syntheticToken = 'mdp_' + '1'.repeat(64);
  f.sqlite
    .prepare(`INSERT INTO publishing_tokens(
      id,user_id,name,token_hash,created_at,expires_at,revoked_at
    ) VALUES(?,?,?,?,?,?,NULL)`)
    .run(
      crypto.randomUUID(),
      testUser.id,
      'Forjada para regressão',
      await hashToken(syntheticToken),
      new Date().toISOString(),
      Math.floor(Date.now() / 1000) + 3600,
    );
  f.values.ACCESS_MODE = 'email';
  assert.equal((await f.publish(syntheticToken, 'test-identity')).status, 401);
});
