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
  return { sqlite, db, owner, guest, stranger };
}
function denied(error: unknown) {
  return error instanceof HttpError && error.status === 404;
}

function pauseConcurrentCommentInserts(db: D1Database) {
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controlled = Object.create(db) as D1Database;
  controlled.prepare = (sql: string) => {
    const statement = db.prepare(sql);
    if (!sql.startsWith('INSERT INTO comments')) return statement;
    return {
      bind(...values: unknown[]) {
        const bound = statement.bind(...values);
        return {
          async run() {
            arrivals += 1;
            if (arrivals === 2) release();
            await gate;
            return bound.run();
          },
        };
      },
    } as unknown as D1PreparedStatement;
  };
  return { controlled, arrivals: () => arrivals };
}

function pauseAfterCommentInsert(db: D1Database) {
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
    if (!sql.startsWith('INSERT INTO comments')) return statement;
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
        authorId: stranger.viewer.id,
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
      authorId: guest.viewer.id,
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
      authorId: guest.viewer.id,
      body: 'Contribuição anterior.',
    });
    await owner.revoke(doc.id, guest.viewer.email);
    await assert.rejects(guest.document(doc.id), denied);
    await assert.rejects(guest.comments(doc.id), denied);
    await assert.rejects(
      guest.addComment(doc.id, {
        id: crypto.randomUUID(),
        authorId: guest.viewer.id,
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
    const payload = {
      id: crypto.randomUUID(),
      authorId: guest.viewer.id,
      body: 'Comentário único.',
    };
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
    const quoted = {
      id: crypto.randomUUID(),
      authorId: guest.viewer.id,
      body: 'Contexto ancorado.',
      quote: 'Proposta',
      sourceStart: 2,
    };
    await guest.addComment(doc.id, quoted);
    for (const divergent of [
      { ...quoted, quote: 'Propost' },
      { ...quoted, sourceStart: 3 },
    ])
      await assert.rejects(
        guest.addComment(doc.id, divergent),
        (error) => error instanceof HttpError && error.status === 409,
      );
    const otherDoc = await owner.create({
      markdown: '# Outra proposta',
      filename: 'outra.md',
    });
    await owner.share(otherDoc.id, { email: guest.viewer.email });
    await assert.rejects(
      guest.addComment(otherDoc.id, quoted),
      (error) => error instanceof HttpError && error.status === 409,
    );
    assert.equal(
      (await owner.comments(doc.id)).find((entry) => entry.id === payload.id)
        ?.body,
      'Comentário único.',
    );
  } finally {
    sqlite.close();
  }
});

void test('duas chamadas pausadas antes do INSERT convergem na mesma contribuição', async () => {
  const { sqlite, db, owner, guest } = fixture();
  try {
    await owner.registerViewer();
    await guest.registerViewer();
    const doc = await owner.create({
      markdown: '# Concorrência',
      filename: 'concorrencia.md',
    });
    await owner.share(doc.id, { email: guest.viewer.email });
    const { controlled, arrivals } = pauseConcurrentCommentInserts(db);
    const concurrentGuest = new DocumentService(controlled, {
      ...guest.viewer,
    });
    const payload = {
      id: crypto.randomUUID(),
      authorId: guest.viewer.id,
      body: 'Uma contribuição concorrente.',
    };
    const [first, second] = await Promise.all([
      concurrentGuest.addComment(doc.id, payload),
      concurrentGuest.addComment(doc.id, payload),
    ]);
    assert.equal(
      arrivals(),
      2,
      'o teste controla as duas chamadas antes do INSERT',
    );
    assert.equal(first.id, payload.id);
    assert.deepEqual(second, first);
    assert.equal((await owner.comments(doc.id)).length, 1);
  } finally {
    sqlite.close();
  }
});

void test('falha inesperada de escrita não é convertida em comentário confirmado', async () => {
  const { sqlite, db, owner } = fixture();
  try {
    await owner.registerViewer();
    const doc = await owner.create({
      markdown: '# Falha',
      filename: 'falha.md',
    });
    const failing = Object.create(db) as D1Database;
    failing.prepare = (sql: string) => {
      const statement = db.prepare(sql);
      if (!sql.startsWith('INSERT INTO comments')) return statement;
      return {
        bind() {
          return {
            async run() {
              throw new Error('storage unavailable');
            },
          };
        },
      } as unknown as D1PreparedStatement;
    };
    const service = new DocumentService(failing, { ...owner.viewer });
    await assert.rejects(
      service.addComment(doc.id, {
        id: crypto.randomUUID(),
        authorId: owner.viewer.id,
        body: 'Não pode parecer sucesso.',
      }),
      /storage unavailable/,
    );
    assert.deepEqual(await owner.comments(doc.id), []);
  } finally {
    sqlite.close();
  }
});

void test('revogação concluída durante o envio impede confirmar ou revelar o comentário', async () => {
  const { sqlite, db, owner, guest } = fixture();
  try {
    await owner.registerViewer();
    await guest.registerViewer();
    const doc = await owner.create({
      markdown: '# Revogação concorrente',
      filename: 'revogacao.md',
    });
    await owner.share(doc.id, { email: guest.viewer.email });
    const schedule = pauseAfterCommentInsert(db);
    const concurrentGuest = new DocumentService(schedule.controlled, {
      ...guest.viewer,
    });
    const sending = concurrentGuest.addComment(doc.id, {
      id: crypto.randomUUID(),
      authorId: guest.viewer.id,
      body: 'Resposta ainda não recebida.',
      quote: 'Revogação concorrente',
      sourceStart: 2,
    });
    await schedule.inserted;
    await owner.revoke(doc.id, guest.viewer.email);
    schedule.resume();
    await assert.rejects(sending, denied);
    assert.equal((await owner.comments(doc.id)).length, 1);
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
        authorId: owner.viewer.id,
        body: 'Teste',
        sourceStart: 999,
      }),
    );
    await assert.rejects(
      owner.addComment(doc.id, {
        id: crypto.randomUUID(),
        body: 'Sem contexto de identidade.',
      }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    await assert.rejects(
      owner.addComment(doc.id, {
        id: crypto.randomUUID(),
        authorId: owner.viewer.id,
        body: ' ',
      }),
    );
    assert.deepEqual(await owner.comments(doc.id), []);
  } finally {
    sqlite.close();
  }
});

void test('upload manual continua inferindo título quando o campo opcional vem vazio ou nulo', async () => {
  const { sqlite, owner } = fixture();
  await owner.registerViewer();
  const empty = await owner.create({
    markdown: '# Título do Markdown',
    filename: 'vazio.md',
    title: '',
  });
  const nullable = await owner.create({
    markdown: 'Sem cabeçalho',
    filename: 'arquivo.md',
    title: null,
  });
  assert.equal(empty.title, 'Título do Markdown');
  assert.equal(nullable.title, 'arquivo');
  sqlite.close();
});
