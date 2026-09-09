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
    document: { id: string };
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
  const values = {
    DB: db,
    APP_ORIGIN: config.origin,
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
  const ownerCookie = ownerLogin.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await data(await f.call('session', 'GET', undefined, ownerCookie)))
      .canCreate,
    true,
  );
  const created = await f.call(
    'documents',
    'POST',
    { markdown: '# Privado\n\nUm trecho.', filename: 'privado.md' },
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
  assert.equal((await data(invited)).emailSubmitted, true);
  assert.equal(f.mailbox.messages.at(-1)?.to, 'guest@example.com');
  assert.equal(f.mailbox.messages.at(-1)?.invitation, true);
  const guestLogin = await f.call('auth/verify', 'POST', {
    token: f.mailbox.lastToken(),
  });
  assert.equal((await data(guestLogin)).redirect, '/d/' + id);
  const guestCookie = guestLogin.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await data(await f.call('session', 'GET', undefined, guestCookie)))
      .canCreate,
    false,
  );
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
  await f.call(
    `documents/${id}/shares`,
    'DELETE',
    { email: 'guest@example.com' },
    ownerCookie,
  );
  assert.equal(
    (await f.call('documents/' + id, 'GET', undefined, guestCookie)).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        `documents/${id}/comments`,
        'POST',
        { id: crypto.randomUUID(), body: 'Sem permissão' },
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

void test('remover convite invalida links antigos, inclusive se a pessoa for adicionada novamente', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const user = await f.login();
  const owner = new DocumentService(f.db, user.viewer);
  const doc = await owner.create({ markdown: '# Teste', filename: 'teste.md' });
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
    { markdown: '# Documento', filename: 'doc.md' },
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
  assert.equal((await data(failed)).emailSubmitted, false);
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
  assert.equal((await data(retried)).emailSubmitted, true);
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
