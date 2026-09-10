import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../lib/api-handler.ts';
import { AuthService } from '../lib/auth-service.ts';
import {
  DocumentService,
  type Viewer,
  type DocumentRow,
  type CommentRow,
} from '../lib/document-service.ts';
import { database, TestMailbox } from './fixture.ts';

const origin = 'https://docs.example.com';
type Body = {
  viewer: Viewer;
  document: DocumentRow;
  documents: DocumentRow[];
  isOwner: boolean;
  canCreate: boolean;
  mode: string;
  redirect: string;
  comments: CommentRow[];
  comment: CommentRow | null;
};
function setup() {
  const { db, sqlite } = database();
  const mailbox = new TestMailbox();
  mailbox.configured = false;
  const values = {
    DB: db,
    APP_ORIGIN: origin,
    APP_OWNER_EMAIL: 'owner@example.com',
    ACCESS_MODE: 'test',
  };
  function client() {
    let cookie = '';
    return {
      async call(
        path: string,
        method = 'GET',
        input?: unknown,
        headers: Record<string, string> = {},
      ) {
        const response = await handleApi(
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
        if (response.headers.has('set-cookie'))
          cookie = response.headers.get('set-cookie')!.split(';')[0];
        return {
          status: response.status,
          body: (await response.json()) as Body,
        };
      },
    };
  }
  return { db, sqlite, mailbox, values, client };
}

void test('modo de teste entra com qualquer e-mail sem credenciais de envio ou confirmação', async (t) => {
  const f = setup();
  t.after(() => f.sqlite.close());
  const user = f.client();
  assert.equal((await user.call('access')).body.mode, 'test');
  assert.equal((await user.call('session')).status, 401);
  const entered = await user.call('auth/test', 'POST', {
    email: 'inventado@example.com',
  });
  assert.equal(entered.status, 200);
  assert.equal(entered.body.redirect, '/documentos');
  const session = await user.call('session');
  assert.equal(session.body.viewer.email, 'inventado@example.com');
  assert.equal(session.body.viewer.isTest, true);
  assert.equal(session.body.canCreate, true);
  assert.equal(f.mailbox.messages.length, 0);
  assert.equal(
    (
      await user.call('auth/request', 'POST', {
        email: 'inventado@example.com',
      })
    ).status,
    404,
  );
  assert.equal(
    (await user.call('auth/verify', 'POST', { token: '0'.repeat(64) })).status,
    404,
  );
});

void test('link permite comentar com outro e-mail; somente a sessão criadora administra o documento', async (t) => {
  const f = setup();
  t.after(() => f.sqlite.close());
  const owner = f.client(),
    guest = f.client();
  await owner.call('auth/test', 'POST', { email: 'primeiro@example.com' });
  const ownerViewer = (await owner.call('session')).body.viewer;
  const created = await owner.call('documents', 'POST', {
    id: crypto.randomUUID(),
    authorId: ownerViewer.id,
    markdown: '# Teste\n\nUm trecho.',
    filename: 'teste.md',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.document.is_test, 1);
  const id = created.body.document.id;
  assert.equal((await guest.call('documents/' + id)).status, 401);
  const entered = await guest.call('auth/test', 'POST', {
    email: 'qualquer@gmail.com',
    documentId: id,
  });
  assert.equal(entered.body.redirect, '/d/' + id);
  const read = await guest.call('documents/' + id);
  assert.equal(read.status, 200);
  assert.equal(read.body.isOwner, false);
  const guestViewerId = (await guest.call('session')).body.viewer.id;
  const comment = await guest.call(`documents/${id}/comments`, 'POST', {
    id: crypto.randomUUID(),
    authorId: guestViewerId,
    body: 'Comentário pelo link',
    quote: 'Um trecho.',
    sourceStart: 9,
  });
  assert.equal(comment.status, 201);
  assert.equal('sequence' in comment.body.comment!, false);
  const commentId = comment.body.comment!.id;
  const lookup = await guest.call(`documents/${id}/comments/${commentId}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.comment?.id, commentId);
  const missing = await guest.call(
    `documents/${id}/comments/${crypto.randomUUID()}`,
  );
  assert.equal(missing.status, 200);
  assert.equal(missing.body.comment, null);
  assert.equal(
    (await guest.call(`documents/${id}/comments/not-found`, 'POST', {})).status,
    404,
  );
  assert.equal(
    (await guest.call(`documents/${id}/shares/not-found`)).status,
    404,
  );
  assert.equal(
    (await guest.call(`documents/${id}/comments?after=invalid`)).status,
    400,
  );
  assert.equal(
    (await guest.call(`documents/${id}/comments?after=invalid&after=duplicate`))
      .status,
    400,
  );
  assert.equal(
    (await guest.call(`documents/${id}/comments?unknown=value`)).status,
    400,
  );
  assert.equal(
    (await owner.call(`documents/${id}/comments`)).body.comments[0].author_name,
    'qualquer@gmail.com',
  );
  assert.equal((await guest.call(`documents/${id}/shares`)).status, 404);
  assert.equal(
    (
      await guest.call(`documents/${id}/shares`, 'POST', {
        email: 'x@example.com',
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await owner.call(`documents/${id}/shares`, 'POST', {
        email: 'x@example.com',
      })
    ).status,
    405,
  );
  assert.equal(f.mailbox.messages.length, 0);
});

void test('digitar o mesmo e-mail de outro dono não assume identidade nem revela sua lista de documentos', async (t) => {
  const f = setup();
  t.after(() => f.sqlite.close());
  const owner = f.client(),
    other = f.client();
  await owner.call('auth/test', 'POST', { email: 'owner@example.com' });
  const ownerViewer = (await owner.call('session')).body.viewer;
  const created = await owner.call('documents', 'POST', {
    id: crypto.randomUUID(),
    authorId: ownerViewer.id,
    markdown: '# Dono',
    filename: 'dono.md',
  });
  await other.call('auth/test', 'POST', { email: 'owner@example.com' });
  assert.notEqual(
    (await owner.call('session')).body.viewer.id,
    (await other.call('session')).body.viewer.id,
  );
  assert.deepEqual((await other.call('documents')).body.documents, []);
  assert.equal(
    (await other.call('documents/' + created.body.document.id)).body.isOwner,
    false,
  );
  assert.equal(
    (await owner.call('documents/' + created.body.document.id)).body.isOwner,
    true,
  );
  // Reentering in the same active browser preserves ownership.
  await owner.call('auth/test', 'POST', { email: 'owner@example.com' });
  assert.equal(
    (await owner.call('documents/' + created.body.document.id)).body.isOwner,
    true,
  );
});

void test('documentos privados e contas reais não são expostos ao habilitar o teste', async (t) => {
  const f = setup();
  t.after(() => f.sqlite.close());
  const real = new DocumentService(f.db, {
    id: 'real-owner',
    name: 'Dono real',
    email: 'owner@example.com',
  });
  await real.registerViewer();
  const privateDoc = await real.create({
    id: crypto.randomUUID(),
    authorId: real.viewer.id,
    markdown: '# Conteúdo privado',
    filename: 'privado.md',
  });
  await real.share(privateDoc.id, { email: 'shared@example.com' });
  const guest = f.client();
  assert.equal(
    (
      await guest.call('auth/test', 'POST', {
        email: 'owner@example.com',
        documentId: privateDoc.id,
      })
    ).status,
    404,
  );
  await guest.call('auth/test', 'POST', { email: 'shared@example.com' });
  assert.equal((await guest.call('documents/' + privateDoc.id)).status, 404);
  assert.deepEqual((await guest.call('documents')).body.documents, []);
  assert.equal(
    (
      await guest.call(`documents/${privateDoc.id}/comments`, 'POST', {
        id: crypto.randomUUID(),
        authorId: (await guest.call('session')).body.viewer.id,
        body: 'Sem acesso',
      })
    ).status,
    404,
  );
  assert.equal(
    (await real.document(privateDoc.id)).markdown,
    '# Conteúdo privado',
  );
});

void test('desabilitar o teste bloqueia a entrada sem confirmação e invalida suas sessões', async (t) => {
  const f = setup();
  t.after(() => f.sqlite.close());
  const guest = f.client();
  await guest.call('auth/test', 'POST', { email: 'example@gmail.com' });
  const guestViewer = (await guest.call('session')).body.viewer;
  const created = await guest.call('documents', 'POST', {
    id: crypto.randomUUID(),
    authorId: guestViewer.id,
    markdown: '# Teste',
    filename: 'teste.md',
  });
  f.values.ACCESS_MODE = 'email';
  assert.equal((await guest.call('access')).body.mode, 'email');
  assert.equal((await guest.call('session')).status, 401);
  assert.equal(
    (
      await guest.call('auth/test', 'POST', {
        email: 'example@gmail.com',
        ACCESS_MODE: 'test',
      })
    ).status,
    404,
  );
  f.mailbox.configured = true;
  const auth = new AuthService(
    f.db,
    { origin, ownerEmail: 'owner@example.com' },
    f.mailbox,
  );
  await auth.requestLink({ email: 'owner@example.com' }, 'test');
  const verified = await auth.redeem(f.mailbox.lastToken());
  const real = new DocumentService(f.db, verified.viewer);
  assert.deepEqual((await real.list()).documents, []);
  await assert.rejects(real.document(created.body.document.id));
});

void test('a entrada de teste rejeita solicitações de outra origem e links inexistentes', async (t) => {
  const f = setup();
  t.after(() => f.sqlite.close());
  const user = f.client();
  assert.equal(
    (
      await user.call(
        'auth/test',
        'POST',
        { email: 'x@example.com' },
        { Origin: 'https://other.example.com' },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await user.call('auth/test', 'POST', {
        email: 'x@example.com',
        documentId: crypto.randomUUID(),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await user.call('auth/test', 'POST', {
        email: 'x@example.com',
        documentId: '//other.example.com',
      })
    ).status,
    404,
  );
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM users').get()?.n, 0);
});
