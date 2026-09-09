import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './fixture.ts';
import { DocumentService, HttpError } from '../lib/document-service.ts';

function fixture() {
  const { sqlite, db } = database();
  const owner = new DocumentService(db, {
    id: 'owner',
    name: 'Dono',
    email: 'owner@example.com',
  });
  const guest = new DocumentService(db, {
    id: 'guest',
    name: 'Convidado',
    email: 'guest@example.com',
  });
  const stranger = new DocumentService(db, {
    id: 'stranger',
    name: 'Terceiro',
    email: 'stranger@example.com',
  });
  return { sqlite, owner, guest, stranger };
}
function denied(error: unknown) {
  return error instanceof HttpError && error.status === 404;
}

void test('somente dono e convidados conseguem ler o documento e os comentários', async () => {
  const { sqlite, owner, guest, stranger } = fixture();
  try {
    await Promise.all([
      owner.registerViewer(),
      guest.registerViewer(),
      stranger.registerViewer(),
    ]);
    const doc = await owner.create({
      markdown: '# Privado\n\n**Conteúdo** interno.',
      filename: 'privado.md',
    });
    assert.equal(
      (await owner.document(doc.id)).markdown,
      '# Privado\n\n**Conteúdo** interno.',
    );
    assert.deepEqual(await guest.list(), []);
    await assert.rejects(guest.document(doc.id), denied);
    await assert.rejects(stranger.comments(doc.id), denied);
    await owner.share(doc.id, {
      email: ' GUEST@example.com ',
      name: 'Convidado',
    });
    assert.equal((await guest.document(doc.id)).title, 'Privado');
    assert.equal((await guest.list()).length, 1);
    await assert.rejects(stranger.document(doc.id), denied);
    await assert.rejects(
      stranger.addComment(doc.id, {
        id: crypto.randomUUID(),
        body: 'Não autorizado',
      }),
      denied,
    );
  } finally {
    sqlite.close();
  }
});

void test('convidado comenta sem poder compartilhar; dono vê o comentário persistido', async () => {
  const { sqlite, owner, guest } = fixture();
  try {
    await owner.registerViewer();
    await guest.registerViewer();
    const doc = await owner.create({
      markdown: '# Proposta\n\nUm trecho.',
      filename: 'proposta.md',
    });
    await owner.share(doc.id, { email: guest.viewer.email });
    const payload = {
      id: crypto.randomUUID(),
      body: 'Precisamos revisar.',
      quote: 'Um trecho.',
      sourceStart: 12,
    };
    await guest.addComment(doc.id, payload);
    const entries = await owner.comments(doc.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].author_name, 'Convidado');
    assert.equal(entries[0].quote, 'Um trecho.');
    await assert.rejects(
      guest.share(doc.id, { email: 'third@example.com' }),
      denied,
    );
    await assert.rejects(guest.shares(doc.id), denied);
    await assert.rejects(guest.revoke(doc.id, guest.viewer.email), denied);
  } finally {
    sqlite.close();
  }
});

void test('revogar acesso bloqueia leitura e novos comentários sem apagar os existentes', async () => {
  const { sqlite, owner, guest } = fixture();
  try {
    await owner.registerViewer();
    await guest.registerViewer();
    const doc = await owner.create({
      markdown: '# Proposta',
      filename: 'proposta.md',
    });
    await owner.share(doc.id, { email: guest.viewer.email });
    await guest.addComment(doc.id, {
      id: crypto.randomUUID(),
      body: 'Contribuição anterior.',
    });
    await owner.revoke(doc.id, guest.viewer.email);
    await assert.rejects(guest.document(doc.id), denied);
    await assert.rejects(guest.comments(doc.id), denied);
    await assert.rejects(
      guest.addComment(doc.id, {
        id: crypto.randomUUID(),
        body: 'Tentativa posterior.',
      }),
      denied,
    );
    assert.deepEqual(await guest.list(), []);
    assert.equal((await owner.comments(doc.id)).length, 1);
    assert.equal((await owner.document(doc.id)).owner_id, 'owner');
  } finally {
    sqlite.close();
  }
});

void test('reenvio do mesmo comentário não duplica e não pode sobrescrever outra contribuição', async () => {
  const { sqlite, owner, guest } = fixture();
  try {
    await owner.registerViewer();
    await guest.registerViewer();
    const doc = await owner.create({
      markdown: '# Proposta',
      filename: 'proposta.md',
    });
    await owner.share(doc.id, { email: guest.viewer.email });
    const payload = { id: crypto.randomUUID(), body: 'Comentário único.' };
    await guest.addComment(doc.id, payload);
    await guest.addComment(doc.id, payload);
    assert.equal((await owner.comments(doc.id)).length, 1);
    await assert.rejects(
      owner.addComment(doc.id, payload),
      (error) => error instanceof HttpError && error.status === 409,
    );
    await assert.rejects(
      guest.addComment(doc.id, { ...payload, body: 'Outro conteúdo.' }),
      (error) => error instanceof HttpError && error.status === 409,
    );
    assert.equal((await owner.comments(doc.id))[0].body, 'Comentário único.');
  } finally {
    sqlite.close();
  }
});

void test('entrada inválida não grava documentos, compartilhamentos ou comentários', async () => {
  const { sqlite, owner } = fixture();
  try {
    await owner.registerViewer();
    await assert.rejects(owner.create({ markdown: ' ', filename: 'vazio.md' }));
    assert.deepEqual(await owner.list(), []);
    const original = '    código com indentação\n\n# Título\n';
    const doc = await owner.create({
      markdown: original,
      filename: 'arquivo.md',
    });
    assert.equal(doc.markdown, original);
    await assert.rejects(owner.share(doc.id, { email: 'invalido' }));
    assert.deepEqual(await owner.shares(doc.id), []);
    await assert.rejects(
      owner.addComment(doc.id, {
        id: crypto.randomUUID(),
        body: 'Teste',
        sourceStart: 999,
      }),
    );
    await assert.rejects(
      owner.addComment(doc.id, { id: crypto.randomUUID(), body: ' ' }),
    );
    assert.deepEqual(await owner.comments(doc.id), []);
  } finally {
    sqlite.close();
  }
});
