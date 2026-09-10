import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthService,
  authConfig,
  LINK_SECONDS,
  SESSION_SECONDS,
} from '../lib/auth-service.ts';
import { DocumentService, HttpError } from '../lib/document-service.ts';
import { handleApi } from '../lib/api-handler.ts';
import { ResendMailer } from '../lib/mailer.ts';
import { database, TestMailbox } from './fixture.ts';

const config = {
  origin: 'https://docs.example.com',
  ownerEmail: 'owner@example.com',
  ownerName: 'Dono',
};
const isDenied = (error: unknown) =>
  error instanceof HttpError && error.status === 401;
async function data(response: Response) {
  return response.json() as Promise<{
    canCreate: boolean;
    viewer: { id: string; email: string; name: string };
    document: { id: string };
    share: { email: string; name: string; created_at: string };
    revokedEmail: string;
    emailSubmitted: boolean;
    redirect: string;
    isOwner: boolean;
    comments: { author_name: string }[];
  }>;
}
function fixture() {
  const { db, sqlite } = database();
  const mailbox = new TestMailbox();
  let now = Math.floor(Date.now() / 1000);
  const auth = new AuthService(db, config, mailbox, () => now);
  const values: Cloudflare.Env = {
    DB: db,
    APP_ORIGIN: config.origin,
    APP_AUTHOR_EMAILS: '',
    APP_OWNER_EMAIL: config.ownerEmail,
    APP_OWNER_NAME: config.ownerName,
  };
  function request(
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = '',
    headers: Record<string, string> = {},
  ) {
    return new Request(config.origin + '/api/' + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: config.origin,
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  }
  const call = (
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = '',
    headers?: Record<string, string>,
  ) => handleApi(request(path, method, body, cookie, headers), values, mailbox);
  async function login(email = config.ownerEmail) {
    await auth.requestLink({ email }, 'test');
    const result = await auth.redeem(mailbox.lastToken());
    assert.equal(result.redirect, '/documentos');
    return { ...result, cookie: auth.cookie(result.session).split(';')[0] };
  }
  return {
    db,
    sqlite,
    mailbox,
    auth,
    values,
    request,
    call,
    login,
    advance: (seconds: number) => {
      now += seconds;
    },
  };
}

function pauseAfterDocumentInsert(db: D1Database) {
  let inserted!: () => void;
  let resume!: () => void;
  const insertedPromise = new Promise<void>((resolve) => {
    inserted = resolve;
  });
  const resumePromise = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const controlled = Object.create(db) as D1Database;
  controlled.prepare = (sql: string) => {
    const statement = db.prepare(sql);
    if (!sql.startsWith('INSERT INTO documents')) return statement;
    return {
      bind(...values: unknown[]) {
        const bound = statement.bind(...values);
        return {
          async run() {
            const result = await bound.run();
            inserted();
            await resumePromise;
            return result;
          },
        };
      },
    } as unknown as D1PreparedStatement;
  };
  return { controlled, inserted: insertedPromise, resume };
}

void test('login exige posse do e-mail: token aleatório, somente hash no banco e consumo único mesmo em concorrência', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const unknown = await f.auth.requestLink(
    { email: 'stranger@example.com' },
    'test',
  );
  assert.equal(f.mailbox.messages.length, 0);
  const known = await f.auth.requestLink(
    { email: ' OWNER@EXAMPLE.COM ' },
    'test',
  );
  assert.deepEqual(known, unknown);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM users').get()?.n, 0);
  const token = f.mailbox.lastToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(f.mailbox.messages[0].to, config.ownerEmail);
  assert.equal(new URL(f.mailbox.messages[0].url).origin, config.origin);
  assert.equal(new URL(f.mailbox.messages[0].url).search, '');
  assert.notEqual(
    f.sqlite.prepare('SELECT token_hash FROM magic_links').get()?.token_hash,
    token,
  );
  await assert.rejects(f.auth.redeem('0'.repeat(64)), isDenied);
  const attempts = await Promise.allSettled([
    f.auth.redeem(token),
    f.auth.redeem(token),
  ]);
  assert.equal(
    attempts.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM sessions').get()?.n, 1);
  await assert.rejects(f.auth.redeem(token), isDenied);
});

void test('link e sessão expiram; logout revoga a sessão no servidor', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await f.auth.requestLink({ email: config.ownerEmail }, 'test');
  const expired = f.mailbox.lastToken();
  f.advance(LINK_SECONDS);
  await assert.rejects(f.auth.redeem(expired), isDenied);
  const user = await f.login();
  assert.equal(user.viewer.name, config.ownerName);
  const request = f.request('session', 'GET', undefined, user.cookie);
  assert.equal((await f.auth.viewer(request))?.email, config.ownerEmail);
  assert.match(
    f.auth.cookie(user.session),
    /^__Host-md_session=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/,
  );
  f.advance(SESSION_SECONDS);
  assert.equal(await f.auth.viewer(request), null);
  const next = await f.login();
  const nextRequest = f.request('session', 'GET', undefined, next.cookie);
  await f.auth.logout(nextRequest);
  assert.equal(await f.auth.viewer(nextRequest), null);
});

void test('fluxo HTTP: dono importa e convida; convidado entra, comenta e perde acesso quando removido', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const ownerRequest = await f.call('auth/request', 'POST', {
    email: config.ownerEmail,
  });
  assert.equal(ownerRequest.status, 200);
  const proof = f.mailbox.lastToken();
  const scanner = await f.call('auth/verify');
  assert.equal(scanner.status, 401);
  const ownerLogin = await f.call('auth/verify', 'POST', { token: proof });
  assert.equal(ownerLogin.status, 200);
  assert.equal((await data(ownerLogin.clone())).redirect, '/documentos');
  const ownerCookie = ownerLogin.headers.get('set-cookie')!.split(';')[0];
  const ownerSession = await data(
    await f.call('session', 'GET', undefined, ownerCookie),
  );
  assert.equal(ownerSession.canCreate, true);
  const created = await f.call(
    'documents',
    'POST',
    {
      id: crypto.randomUUID(),
      authorId: ownerSession.viewer.id,
      markdown: '# Privado\n\nUm trecho.',
      filename: 'privado.md',
    },
    ownerCookie,
  );
  assert.equal(created.status, 201);
  const id = (await data(created)).document.id as string;
  const invited = await f.call(
    `documents/${id}/shares`,
    'POST',
    { email: 'guest@example.com', name: 'Pessoa convidada' },
    ownerCookie,
  );
  const invitedData = await data(invited);
  assert.equal(invitedData.emailSubmitted, true);
  assert.equal(invitedData.share.email, 'guest@example.com');
  assert.equal('shares' in invitedData, false);
  assert.equal(f.mailbox.messages.at(-1)?.to, 'guest@example.com');
  assert.equal(f.mailbox.messages.at(-1)?.invitation, true);
  const guestLogin = await f.call('auth/verify', 'POST', {
    token: f.mailbox.lastToken(),
  });
  assert.equal((await data(guestLogin)).redirect, '/d/' + id);
  const guestCookie = guestLogin.headers.get('set-cookie')!.split(';')[0];
  const guestSession = await data(
    await f.call('session', 'GET', undefined, guestCookie),
  );
  assert.equal(guestSession.canCreate, false);
  const read = await f.call('documents/' + id, 'GET', undefined, guestCookie);
  assert.equal(read.status, 200);
  assert.equal((await data(read)).isOwner, false);
  assert.equal(
    (
      await f.call(
        'documents',
        'POST',
        { markdown: '# Fora do escopo', filename: 'nao.md' },
        guestCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        `documents/${id}/shares`,
        'POST',
        { email: 'third@example.com' },
        guestCookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        `documents/${id}/comments`,
        'POST',
        {
          id: crypto.randomUUID(),
          authorId: guestSession.viewer.id,
          body: 'Minha contribuição',
          quote: 'Um trecho.',
          sourceStart: 11,
        },
        guestCookie,
      )
    ).status,
    201,
  );
  const comments = (
    await data(
      await f.call(`documents/${id}/comments`, 'GET', undefined, ownerCookie),
    )
  ).comments;
  assert.equal(comments[0].author_name, 'Pessoa convidada');
  const revoked = await f.call(
    `documents/${id}/shares`,
    'DELETE',
    { email: 'guest@example.com' },
    ownerCookie,
  );
  const revokedData = await data(revoked);
  assert.equal(revokedData.revokedEmail, 'guest@example.com');
  assert.equal('shares' in revokedData, false);
  assert.equal(
    (await f.call('documents/' + id, 'GET', undefined, guestCookie)).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        `documents/${id}/comments`,
        'POST',
        {
          id: crypto.randomUUID(),
          authorId: guestSession.viewer.id,
          body: 'Sem permissão',
        },
        guestCookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.call('documents/' + id, 'GET', undefined, ownerCookie)).status,
    200,
  );
  const logout = await f.call('auth/logout', 'POST', {}, guestCookie);
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal(
    (await f.call('session', 'GET', undefined, guestCookie)).status,
    401,
  );
});

void test('listas HTTP aceitam somente um cursor opcional e preservam envelopes nomeados', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const owner = await f.login();
  const created = await f.call(
    'documents',
    'POST',
    {
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      markdown: '# Envelope',
      filename: 'envelope.md',
    },
    owner.cookie,
  );
  const id = (await data(created)).document.id;
  const documents = (await f.call(
    'documents',
    'GET',
    undefined,
    owner.cookie,
  )) as Response;
  assert.deepEqual(Object.keys((await documents.json()) as object).sort(), [
    'documents',
    'nextCursor',
  ]);
  const shares = await f.call(
    `documents/${id}/shares`,
    'GET',
    undefined,
    owner.cookie,
  );
  assert.deepEqual(Object.keys((await shares.json()) as object).sort(), [
    'nextCursor',
    'shares',
  ]);
  for (const path of [
    'documents?limit=1',
    'documents?cursor=one&cursor=two',
    'documents?cursor=',
    `documents/${id}/shares?limit=1`,
    `documents/${id}/shares?cursor=one&cursor=two`,
    `documents/${id}/shares?cursor=`,
  ])
    assert.equal(
      (await f.call(path, 'GET', undefined, owner.cookie)).status,
      400,
      path,
    );
});

void test('POST documents exige UUID e autor da sessão sem fallback para outra operação', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const owner = await f.login();
  const base = { markdown: '# Contrato', filename: 'contrato.md' };
  for (const invalid of [
    base,
    { ...base, id: crypto.randomUUID() },
    { ...base, id: [crypto.randomUUID()], authorId: owner.viewer.id },
    {
      ...base,
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      title: [],
    },
  ])
    assert.equal(
      (await f.call('documents', 'POST', invalid, owner.cookie)).status,
      400,
    );
  assert.equal(
    (
      await f.call(
        'documents',
        'POST',
        { ...base, id: crypto.randomUUID(), authorId: 'outra-sessão' },
        owner.cookie,
      )
    ).status,
    409,
  );
  assert.equal(
    f.sqlite.prepare('SELECT count(*) n FROM documents').get()?.n,
    0,
  );
});

void test('perda de canCreate durante a escrita impede confirmar o documento', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const owner = await f.login();
  const operationId = crypto.randomUUID();
  const schedule = pauseAfterDocumentInsert(f.db);
  f.values.DB = schedule.controlled;
  const pending = f.call(
    'documents',
    'POST',
    {
      id: operationId,
      authorId: owner.viewer.id,
      markdown: '# Sem confirmação',
      filename: 'sem-confirmacao.md',
    },
    owner.cookie,
  );
  await schedule.inserted;
  f.values.APP_OWNER_EMAIL = undefined;
  schedule.resume();
  assert.equal((await pending).status, 403);
  assert.equal(
    f.sqlite
      .prepare('SELECT count(*) n FROM documents WHERE id=?')
      .get(operationId)?.n,
    1,
  );
});

void test('remover convite invalida links antigos, inclusive se a pessoa for adicionada novamente', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const user = await f.login();
  const owner = new DocumentService(f.db, user.viewer);
  const doc = await owner.create({
    id: crypto.randomUUID(),
    authorId: owner.viewer.id,
    markdown: '# Teste',
    filename: 'teste.md',
  });
  await owner.share(doc.id, { email: 'guest@example.com' });
  await f.auth.invite('guest@example.com', doc.id, user.viewer.id);
  const old = f.mailbox.lastToken();
  await owner.revoke(doc.id, 'guest@example.com');
  await owner.share(doc.id, { email: 'guest@example.com' });
  await assert.rejects(f.auth.redeem(old), isDenied);
  const count = f.mailbox.messages.length;
  await f.auth.requestLink(
    { email: 'stranger@example.com', documentId: doc.id },
    'test',
  );
  assert.equal(f.mailbox.messages.length, count);
  await f.auth.invite('guest@example.com', doc.id, user.viewer.id);
  await f.db
    .prepare('DELETE FROM shares WHERE document_id=?')
    .bind(doc.id)
    .run();
  await assert.rejects(f.auth.redeem(f.mailbox.lastToken()), isDenied);
});

void test('configuração normaliza e deduplica autores sem desabilitar o dono legado', () => {
  const configured = authConfig({
    APP_ORIGIN: config.origin,
    APP_AUTHOR_EMAILS:
      ' Autora@Example.com,autor@example.com, AUTORA@example.com ,,',
  });
  assert.equal(configured.ownerEmail, undefined);
  assert.deepEqual(configured.authorEmails, [
    'autora@example.com',
    'autor@example.com',
  ]);
  assert.equal(configured.authorMode, 'allowlist');

  const open = authConfig({
    APP_ORIGIN: config.origin,
    APP_AUTHOR_MODE: ' open ',
    APP_AUTHOR_EMAILS: '',
  });
  assert.equal(open.authorMode, 'open');
  assert.deepEqual(open.authorEmails, []);

  const legacy = authConfig({
    APP_ORIGIN: config.origin,
    APP_OWNER_EMAIL: ' OWNER@EXAMPLE.COM ',
    APP_OWNER_NAME: 'Dono legado',
  });
  assert.equal(legacy.ownerEmail, config.ownerEmail);
  assert.equal(legacy.ownerName, 'Dono legado');
  assert.deepEqual(legacy.authorEmails, []);

  assert.throws(() =>
    authConfig({
      APP_ORIGIN: config.origin,
      APP_AUTHOR_EMAILS: 'invalido',
    }),
  );
  assert.deepEqual(authConfig({ APP_ORIGIN: config.origin }).authorEmails, []);
  assert.equal(
    authConfig({ APP_ORIGIN: config.origin, APP_AUTHOR_MODE: '' }).authorMode,
    'allowlist',
  );
  assert.throws(() =>
    authConfig({ APP_ORIGIN: config.origin, APP_AUTHOR_MODE: 'public' }),
  );
});

void test('dois autores entram sem convite, recuperam identidade e ficam isolados por plano via HTTP', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  f.values.APP_AUTHOR_EMAILS =
    ' AUTORA@example.com, autorb@example.com,autora@example.com ';

  async function login(email: string) {
    const before = f.mailbox.messages.length;
    const requested = await f.call('auth/request', 'POST', { email });
    assert.equal(requested.status, 200);
    assert.equal(f.mailbox.messages.length, before + 1);
    const verified = await f.call('auth/verify', 'POST', {
      token: f.mailbox.lastToken(),
    });
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get('set-cookie')!.split(';')[0];
    return {
      cookie,
      session: await data(await f.call('session', 'GET', undefined, cookie)),
    };
  }

  const firstA = await login('autora@example.com');
  assert.equal(firstA.session.canCreate, true);
  assert.equal(firstA.session.viewer.name, 'autora@example.com');
  const documentA = await f.call(
    'documents',
    'POST',
    {
      id: crypto.randomUUID(),
      authorId: firstA.session.viewer.id,
      markdown: '# Plano A',
      filename: 'a.md',
    },
    firstA.cookie,
  );
  assert.equal(documentA.status, 201);
  const idA = (await data(documentA)).document.id;

  const secondA = await login(' AUTORA@EXAMPLE.COM ');
  assert.equal(secondA.session.viewer.id, firstA.session.viewer.id);
  assert.equal(
    (await f.call('documents/' + idA, 'GET', undefined, secondA.cookie)).status,
    200,
  );

  const authorB = await login('autorb@example.com');
  const documentB = await f.call(
    'documents',
    'POST',
    {
      id: crypto.randomUUID(),
      authorId: authorB.session.viewer.id,
      markdown: '# Plano B',
      filename: 'b.md',
    },
    authorB.cookie,
  );
  assert.equal(documentB.status, 201);
  const idB = (await data(documentB)).document.id;

  assert.equal(
    (await f.call('documents/' + idB, 'GET', undefined, secondA.cookie)).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        `documents/${idB}/comments`,
        'POST',
        {
          id: crypto.randomUUID(),
          authorId: secondA.session.viewer.id,
          body: 'Sem convite',
        },
        secondA.cookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        `documents/${idB}/shares`,
        'POST',
        { email: 'guest@example.com' },
        secondA.cookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (await f.call('documents/' + idA, 'GET', undefined, authorB.cookie)).status,
    404,
  );

  const messages = f.mailbox.messages.length;
  assert.equal(
    (
      await f.call('auth/request', 'POST', {
        email: 'autora@example.com',
        documentId: idB,
      })
    ).status,
    200,
  );
  assert.equal(f.mailbox.messages.length, messages);
});

void test('revogar habilitação bloqueia criação e resgate sem acesso, preservando planos existentes', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  f.values.APP_OWNER_EMAIL = undefined;
  f.values.APP_AUTHOR_EMAILS =
    'autora@example.com,autor-sem-planos@example.com';

  async function login(email: string) {
    await f.call('auth/request', 'POST', { email });
    const verified = await f.call('auth/verify', 'POST', {
      token: f.mailbox.lastToken(),
    });
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get('set-cookie')!.split(';')[0];
    return {
      cookie,
      viewer: (await data(await f.call('session', 'GET', undefined, cookie)))
        .viewer,
    };
  }

  const author = await login('autora@example.com');
  const idleAuthor = await login('autor-sem-planos@example.com');
  const created = await f.call(
    'documents',
    'POST',
    {
      id: crypto.randomUUID(),
      authorId: author.viewer.id,
      markdown: '# Já existente',
      filename: 'existente.md',
    },
    author.cookie,
  );
  const id = (await data(created)).document.id;

  await f.call('auth/request', 'POST', { email: 'autora@example.com' });
  const ownerToken = f.mailbox.lastToken();
  await f.call('auth/request', 'POST', {
    email: 'autor-sem-planos@example.com',
  });
  const idleToken = f.mailbox.lastToken();
  f.values.APP_AUTHOR_EMAILS = '';

  assert.equal(
    (
      await f.call(
        'documents',
        'POST',
        { markdown: '# Bloqueado', filename: 'bloqueado.md' },
        author.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        'documents',
        'POST',
        { markdown: '# Bloqueado', filename: 'bloqueado.md' },
        idleAuthor.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.call('documents/' + id, 'GET', undefined, author.cookie)).status,
    200,
  );

  const recovered = await f.call('auth/verify', 'POST', { token: ownerToken });
  assert.equal(recovered.status, 200);
  const recoveredCookie = recovered.headers.get('set-cookie')!.split(';')[0];
  const recoveredSession = await data(
    await f.call('session', 'GET', undefined, recoveredCookie),
  );
  assert.equal(recoveredSession.viewer.id, author.viewer.id);
  assert.equal(recoveredSession.canCreate, false);
  assert.equal(
    (await f.call('documents/' + id, 'GET', undefined, recoveredCookie)).status,
    200,
  );
  assert.equal(
    (await f.call('auth/verify', 'POST', { token: idleToken })).status,
    401,
  );
});

void test('revogação é seletiva entre planos e invalida somente o convite pendente removido', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const owner = await f.login();
  const first = await f.call(
    'documents',
    'POST',
    {
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      markdown: '# Primeiro',
      filename: 'primeiro.md',
    },
    owner.cookie,
  );
  const second = await f.call(
    'documents',
    'POST',
    {
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      markdown: '# Segundo',
      filename: 'segundo.md',
    },
    owner.cookie,
  );
  const firstId = (await data(first)).document.id;
  const secondId = (await data(second)).document.id;

  await f.call(
    `documents/${firstId}/shares`,
    'POST',
    { email: 'guest@example.com', name: 'Convidada' },
    owner.cookie,
  );
  const pendingFirst = f.mailbox.lastToken();
  await f.call(
    `documents/${secondId}/shares`,
    'POST',
    { email: 'guest@example.com', name: 'Convidada' },
    owner.cookie,
  );
  const guestLogin = await f.call('auth/verify', 'POST', {
    token: f.mailbox.lastToken(),
  });
  const guestCookie = guestLogin.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await f.call('documents/' + firstId, 'GET', undefined, guestCookie))
      .status,
    200,
  );
  assert.equal(
    (await f.call('documents/' + secondId, 'GET', undefined, guestCookie))
      .status,
    200,
  );

  await f.call(
    `documents/${firstId}/shares`,
    'DELETE',
    { email: 'guest@example.com' },
    owner.cookie,
  );
  assert.equal(
    (await f.call('documents/' + firstId, 'GET', undefined, guestCookie))
      .status,
    404,
  );
  assert.equal(
    (await f.call('documents/' + secondId, 'GET', undefined, guestCookie))
      .status,
    200,
  );
  assert.equal(
    (await f.call('auth/verify', 'POST', { token: pendingFirst })).status,
    401,
  );
  assert.equal(
    (await f.call('documents/' + secondId, 'GET', undefined, guestCookie))
      .status,
    200,
  );
});

void test('autoria aberta não converte identidade nem dados legados de teste', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  f.values.APP_AUTHOR_MODE = 'open';
  f.values.APP_AUTHOR_EMAILS = '';
  const testOwner = crypto.randomUUID();
  const testDocument = crypto.randomUUID();
  f.sqlite
    .prepare('INSERT INTO users(id,email,name,test_email) VALUES(?,?,?,?)')
    .run(
      testOwner,
      `test.${testOwner}@sessions.invalid`,
      'Identidade de teste',
      'autora@example.com',
    );
  f.sqlite
    .prepare(
      `INSERT INTO documents(id,owner_id,title,filename,markdown,is_test,created_at)
      VALUES(?,?,?,?,?,1,?)`,
    )
    .run(
      testDocument,
      testOwner,
      'Teste',
      'teste.md',
      '# Teste',
      new Date().toISOString(),
    );
  f.sqlite
    .prepare(
      'INSERT INTO shares(document_id,email,name,created_at) VALUES(?,?,?,?)',
    )
    .run(
      testDocument,
      'autora@example.com',
      'Nome vindo do teste',
      new Date().toISOString(),
    );
  f.sqlite
    .prepare(
      'INSERT INTO shares(document_id,email,name,created_at) VALUES(?,?,?,?)',
    )
    .run(
      testDocument,
      'estranha@example.com',
      'Estranha no teste',
      new Date().toISOString(),
    );

  await f.call('auth/request', 'POST', { email: 'autora@example.com' });
  const verified = await f.call('auth/verify', 'POST', {
    token: f.mailbox.lastToken(),
  });
  assert.equal(verified.status, 200);
  const verifiedCookie = verified.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await data(await f.call('session', 'GET', undefined, verifiedCookie)))
      .viewer.name,
    'autora@example.com',
  );

  const messages = f.mailbox.messages.length;
  await f.call('auth/request', 'POST', {
    email: 'autora@example.com',
    documentId: testDocument,
  });
  assert.equal(f.mailbox.messages.length, messages);
  await f.call('auth/request', 'POST', { email: 'estranha@example.com' });
  assert.equal(f.mailbox.messages.length, messages + 1);
  const strangerToken = f.mailbox.lastToken();
  await f.call('auth/request', 'POST', {
    email: 'estranha@example.com',
    documentId: testDocument,
  });
  assert.equal(f.mailbox.messages.length, messages + 1);

  const strangerLogin = await f.call('auth/verify', 'POST', {
    token: strangerToken,
  });
  assert.equal(strangerLogin.status, 200);
  const strangerCookie = strangerLogin.headers.get('set-cookie')!.split(';')[0];
  const stranger = await data(
    await f.call('session', 'GET', undefined, strangerCookie),
  );
  assert.equal(stranger.viewer.name, 'estranha@example.com');
  assert.notEqual(stranger.viewer.id, testOwner);
  assert.equal(stranger.canCreate, true);
  assert.equal(
    (
      await f.call(
        'documents/' + testDocument,
        'GET',
        undefined,
        strangerCookie,
      )
    ).status,
    404,
  );
});

void test('API rejeita identidade forjada e solicitações de outra origem sem criar acesso', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  assert.equal(
    (
      await f.call('session', 'GET', undefined, '', {
        'oai-authenticated-user-id': 'owner',
        'oai-authenticated-user-email': config.ownerEmail,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call('auth/request', 'POST', { email: config.ownerEmail }, '', {
        Origin: 'https://malicious.example',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call('auth/request', 'POST', { email: config.ownerEmail }, '', {
        'Content-Type': 'text/plain',
      })
    ).status,
    415,
  );
  assert.equal(
    (await f.call('auth/request', 'POST', { email: 'invalid' })).status,
    400,
  );
  assert.equal(
    (
      await f.call('auth/request', 'POST', {
        email: config.ownerEmail,
        documentId: '//malicious.example',
      })
    ).status,
    400,
  );
  assert.equal(f.mailbox.messages.length, 0);
  assert.throws(() =>
    authConfig({
      APP_ORIGIN: 'https://good.example@malicious.example/evil',
      APP_OWNER_EMAIL: config.ownerEmail,
    }),
  );
  assert.throws(() =>
    authConfig({
      APP_ORIGIN: 'http://public.example',
      APP_OWNER_EMAIL: config.ownerEmail,
    }),
  );
});

void test('limites são atômicos e pedidos repetidos não enviam e-mails ilimitados', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const attempts = await Promise.allSettled(
    Array.from({ length: 10 }, () => f.auth.limit('test', 'address', 2, 60)),
  );
  assert.equal(
    attempts.filter((result) => result.status === 'fulfilled').length,
    2,
  );
  f.advance(60);
  await f.auth.limit('test', 'address', 2, 60);
  for (let index = 0; index < 5; index++)
    await f.auth.requestLink({ email: config.ownerEmail }, 'test');
  await assert.rejects(
    f.auth.requestLink({ email: config.ownerEmail }, 'test'),
    (error) => error instanceof HttpError && error.status === 429,
  );
  assert.equal(f.mailbox.messages.length, 5);
});

void test('falha do provedor não é sucesso; reenvio manual recupera o convite sem duplicar acesso', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const owner = await f.login();
  const created = await f.call(
    'documents',
    'POST',
    {
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      markdown: '# Documento',
      filename: 'doc.md',
    },
    owner.cookie,
  );
  const id = (await data(created)).document.id as string;
  f.mailbox.configured = false;
  assert.equal(
    (
      await f.call(
        `documents/${id}/shares`,
        'POST',
        { email: 'guest@example.com' },
        owner.cookie,
      )
    ).status,
    503,
  );
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM shares').get()?.n, 0);
  f.mailbox.configured = true;
  f.mailbox.fail = true;
  const failed = await f.call(
    `documents/${id}/shares`,
    'POST',
    { email: 'guest@example.com' },
    owner.cookie,
  );
  const failedData = await data(failed);
  assert.equal(failedData.emailSubmitted, false);
  assert.equal(failedData.share.email, 'guest@example.com');
  assert.equal('shares' in failedData, false);
  assert.equal(
    f.sqlite
      .prepare('SELECT count(*) n FROM magic_links WHERE used_at IS NULL')
      .get()?.n,
    0,
  );
  // Anonymous responses do not expose whether the account exists or mail failed.
  assert.deepEqual(
    await f.auth.requestLink({ email: config.ownerEmail }, 'test'),
    await f.auth.requestLink({ email: 'unknown@example.com' }, 'test'),
  );
  f.mailbox.fail = false;
  const retried = await f.call(
    `documents/${id}/shares`,
    'POST',
    { email: 'guest@example.com' },
    owner.cookie,
  );
  const retriedData = await data(retried);
  assert.equal(retriedData.emailSubmitted, true);
  assert.deepEqual(retriedData.share, failedData.share);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM shares').get()?.n, 1);
  assert.equal(
    (await f.auth.redeem(f.mailbox.lastToken())).viewer.email,
    'guest@example.com',
  );
});

void test('adaptador de e-mail usa o provedor configurado, limita espera e rejeita resposta sem confirmação', async () => {
  let calls = 0;
  const transport: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(
      new Headers(options?.headers).get('Idempotency-Key'),
      'unique-message',
    );
    assert.equal(
      JSON.parse(options?.body as string).to[0],
      'guest@example.com',
    );
    assert.equal(JSON.parse(options?.body as string).html, undefined);
    assert.ok(options?.signal);
    return Response.json({ id: 'provider-id' });
  };
  const email = {
    to: 'guest@example.com',
    url: config.origin + '/access#token=test',
    invitation: true,
    id: 'unique-message',
  };
  await new ResendMailer(
    'test-key',
    'Documentos <access@example.com>',
    transport,
  ).send(email);
  assert.equal(calls, 1);
  await assert.rejects(
    new ResendMailer(undefined, undefined, transport).send(email),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    new ResendMailer(
      'test-key',
      'access@example.com',
      async () => new Response('', { status: 403 }),
    ).send(email),
  );
  await assert.rejects(
    new ResendMailer('test-key', 'access@example.com', async () =>
      Response.json({}),
    ).send(email),
  );
});

void test('autoria aberta exige e-mail confirmado e mantém cada plano privado por convite', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  f.values.APP_AUTHOR_MODE = 'open';

  const access = (await f.call('access', 'GET')) as Response;
  assert.deepEqual(await access.json(), {
    mode: 'email',
    authorMode: 'open',
  });

  const requested = await f.call('auth/request', 'POST', {
    email: 'nova@example.com',
  });
  assert.equal(requested.status, 200);
  assert.equal(f.mailbox.messages.at(-1)?.to, 'nova@example.com');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM users').get()?.n, 0);
  assert.equal(
    (
      await f.call('documents', 'POST', {
        id: crypto.randomUUID(),
        authorId: crypto.randomUUID(),
        markdown: '# Sem confirmação',
        filename: 'sem-confirmacao.md',
      })
    ).status,
    401,
  );
  assert.equal(
    (await f.call('auth/verify', 'POST', { token: '0'.repeat(64) })).status,
    401,
  );
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM users').get()?.n, 0);

  async function verifyLast() {
    const response = await f.call('auth/verify', 'POST', {
      token: f.mailbox.lastToken(),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const session = await data(
      await f.call('session', 'GET', undefined, cookie),
    );
    assert.equal(session.canCreate, true);
    return { cookie, viewer: session.viewer };
  }

  const first = await verifyLast();
  const createdFirst = await f.call(
    'documents',
    'POST',
    {
      id: crypto.randomUUID(),
      authorId: first.viewer.id,
      markdown: '# Plano privado A',
      filename: 'a.md',
    },
    first.cookie,
  );
  assert.equal(createdFirst.status, 201);
  const firstId = (await data(createdFirst)).document.id;

  await f.call('auth/request', 'POST', { email: 'outra@example.com' });
  const second = await verifyLast();
  const createdSecond = await f.call(
    'documents',
    'POST',
    {
      id: crypto.randomUUID(),
      authorId: second.viewer.id,
      markdown: '# Plano privado B',
      filename: 'b.md',
    },
    second.cookie,
  );
  assert.equal(createdSecond.status, 201);
  const secondId = (await data(createdSecond)).document.id;

  assert.equal(
    (await f.call('documents/' + secondId, 'GET', undefined, first.cookie))
      .status,
    404,
  );
  assert.equal(
    (
      await f.call(
        `documents/${secondId}/comments`,
        'POST',
        {
          id: crypto.randomUUID(),
          authorId: first.viewer.id,
          body: 'Autor sem convite continua estranho.',
        },
        first.cookie,
      )
    ).status,
    404,
  );
  const firstPrivateList = (await (
    await f.call('documents', 'GET', undefined, first.cookie)
  ).json()) as { documents: { id: string }[] };
  assert.deepEqual(
    firstPrivateList.documents.map((document) => document.id),
    [firstId],
  );

  const shared = await f.call(
    `documents/${secondId}/shares`,
    'POST',
    { email: 'nova@example.com', name: 'Nova autora' },
    second.cookie,
  );
  assert.equal(shared.status, 200);
  const pendingInvitation = f.mailbox.lastToken();
  const sharedList = (await (
    await f.call('documents', 'GET', undefined, first.cookie)
  ).json()) as { documents: { id: string }[] };
  assert.deepEqual(
    new Set(sharedList.documents.map((document) => document.id)),
    new Set([firstId, secondId]),
  );
  assert.equal(
    (await f.call('documents/' + secondId, 'GET', undefined, first.cookie))
      .status,
    200,
  );

  assert.equal(
    (
      await f.call(
        `documents/${secondId}/shares`,
        'DELETE',
        { email: 'nova@example.com' },
        second.cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.call('documents/' + secondId, 'GET', undefined, first.cookie))
      .status,
    404,
  );
  assert.equal(
    (await f.call('auth/verify', 'POST', { token: pendingInvitation })).status,
    401,
  );
  assert.equal(
    (await data(await f.call('session', 'GET', undefined, first.cookie)))
      .canCreate,
    true,
  );
});
