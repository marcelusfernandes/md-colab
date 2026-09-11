import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../lib/api-handler.ts';
import { AuthService } from '../lib/auth-service.ts';
import type { DocumentRevisionReceipt, DocumentRow } from '../lib/document-service.ts';
import { database, TestMailbox } from './fixture.ts';

const origin = 'https://docs.example.com';

function fixture() {
  const { db, sqlite } = database();
  const mailbox = new TestMailbox();
  const values: Cloudflare.Env = {
    DB: db,
    APP_ORIGIN: origin,
    APP_OWNER_EMAIL: 'owner@example.com',
    APP_OWNER_NAME: 'Dona',
  };
  const auth = new AuthService(
    db,
    { origin, ownerEmail: 'owner@example.com', ownerName: 'Dona' },
    mailbox,
  );
  const call = (
    path: string,
    method = 'GET',
    input?: unknown,
    cookie = '',
  ) =>
    handleApi(
      new Request(`${origin}/api/${path}`, {
        method,
        headers: {
          Origin: origin,
          Cookie: cookie,
          'Content-Type': 'application/json',
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(input ?? {}) }),
      }),
      values,
      mailbox,
    );
  async function ownerLogin() {
    await auth.requestLink({ email: 'owner@example.com' }, 'test');
    const redeemed = await auth.redeem(mailbox.lastToken());
    return { ...redeemed, cookie: auth.cookie(redeemed.session).split(';')[0] };
  }
  return { sqlite, values, mailbox, auth, call, ownerLogin };
}

void test('rota de revisão exige autor habilitado e GET segue acesso atual do plano', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const owner = await f.ownerLogin();
  const documentId = crypto.randomUUID();
  const created = await f.call(
    'documents',
    'POST',
    {
      id: documentId,
      authorId: owner.viewer.id,
      markdown: '# Inicial',
      filename: 'inicial.md',
    },
    owner.cookie,
  );
  assert.equal(created.status, 201);
  const document = ((await created.json()) as { document: DocumentRow }).document;
  const revisionId = crypto.randomUUID();
  const request = {
    id: revisionId,
    baseRevisionId: document.current_revision_id,
    markdown: '# Segunda\n\nConteúdo.',
    filename: 'segunda.md',
    summary: 'Atualiza o plano',
    consideredCommentIds: [],
  };
  assert.equal(
    (await f.call(`documents/${documentId}/revisions`, 'POST', request)).status,
    401,
  );
  const published = await f.call(
    `documents/${documentId}/revisions`,
    'POST',
    request,
    owner.cookie,
  );
  assert.equal(published.status, 201);
  const receipt = ((await published.json()) as { revision: DocumentRevisionReceipt })
    .revision;
  assert.equal(receipt.id, revisionId);
  assert.equal(receipt.ordinal, 2);
  assert.deepEqual(receipt.considered_comment_ids, []);
  assert.deepEqual(receipt.considered_comments, []);
  assert.equal(
    (
      await f.call(
        `documents/${documentId}/revisions`,
        'POST',
        request,
        owner.cookie,
      )
    ).status,
    200,
  );
  const exact = await f.call(
    `documents/${documentId}/revisions/${revisionId}`,
    'GET',
    undefined,
    owner.cookie,
  );
  assert.equal(exact.status, 200);
  assert.deepEqual(
    ((await exact.json()) as { revision: DocumentRevisionReceipt }).revision,
    receipt,
  );

  const shared = await f.call(
    `documents/${documentId}/shares`,
    'POST',
    { email: 'guest@example.com' },
    owner.cookie,
  );
  assert.equal(shared.status, 200);
  const invited = await f.auth.redeem(f.mailbox.lastToken());
  const guestCookie = f.auth.cookie(invited.session).split(';')[0];
  assert.equal(
    (
      await f.call(
        `documents/${documentId}/revisions/${revisionId}`,
        'GET',
        undefined,
        guestCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        `documents/${documentId}/revisions`,
        'POST',
        { ...request, id: crypto.randomUUID() },
        guestCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        `documents/${documentId}/shares`,
        'DELETE',
        { email: 'guest@example.com' },
        owner.cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        `documents/${documentId}/revisions/${revisionId}`,
        'GET',
        undefined,
        guestCookie,
      )
    ).status,
    404,
  );

  f.values.APP_OWNER_EMAIL = undefined;
  assert.equal(
    (
      await f.call(
        `documents/${documentId}/revisions`,
        'POST',
        request,
        owner.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        `documents/${documentId}/revisions/${revisionId}`,
        'GET',
        undefined,
        owner.cookie,
      )
    ).status,
    200,
  );
});

void test('rota recusa JSON acima de 2 MB antes de criar snapshot', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  const owner = await f.ownerLogin();
  const documentId = crypto.randomUUID();
  await f.call(
    'documents',
    'POST',
    {
      id: documentId,
      authorId: owner.viewer.id,
      markdown: '# Inicial',
      filename: 'inicial.md',
    },
    owner.cookie,
  );
  const response = await f.call(
    `documents/${documentId}/revisions`,
    'POST',
    {
      id: crypto.randomUUID(),
      baseRevisionId: documentId,
      markdown: 'x'.repeat(2 * 1024 * 1024),
      filename: 'grande.md',
      consideredCommentIds: [],
    },
    owner.cookie,
  );
  assert.equal(response.status, 413);
});
