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
function createDocument(
  service: DocumentService,
  input: Record<string, unknown>,
) {
  return service.create({
    id: crypto.randomUUID(),
    authorId: service.viewer.id,
    ...input,
  });
}

function stableCommentId(index: number) {
  const value = index.toString(16);
  return `${value.padStart(8, '0')}-0000-4000-8000-${value.padStart(12, '0')}`;
}

function assertVisualOrder(entries: { id: string; created_at: string }[]) {
  const expected = [...entries].sort(
    (left, right) =>
      left.created_at.localeCompare(right.created_at) ||
      left.id.localeCompare(right.id),
  );
  assert.deepEqual(
    entries.map((entry) => entry.id),
    expected.map((entry) => entry.id),
  );
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

function pauseConcurrentDocumentInserts(db: D1Database) {
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
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
    const doc = await createDocument(owner, {
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
    const doc = await createDocument(owner, {
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
    const { comments: entries } = await owner.comments(doc.id);
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
    const doc = await createDocument(owner, {
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
    assert.equal((await owner.comments(doc.id)).comments.length, 1);
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
    const doc = await createDocument(owner, {
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
    assert.equal((await owner.comments(doc.id)).comments.length, 1);
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
    const otherDoc = await createDocument(owner, {
      markdown: '# Outra proposta',
      filename: 'outra.md',
    });
    await owner.share(otherDoc.id, { email: guest.viewer.email });
    await assert.rejects(
      guest.addComment(otherDoc.id, quoted),
      (error) => error instanceof HttpError && error.status === 409,
    );
    assert.equal(
      (await owner.comments(doc.id)).comments.find(
        (entry) => entry.id === payload.id,
      )?.body,
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
    const doc = await createDocument(owner, {
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
    assert.equal((await owner.comments(doc.id)).comments.length, 1);
  } finally {
    sqlite.close();
  }
});

void test('falha inesperada de escrita não é convertida em comentário confirmado', async () => {
  const { sqlite, db, owner } = fixture();
  try {
    await owner.registerViewer();
    const doc = await createDocument(owner, {
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
    assert.deepEqual((await owner.comments(doc.id)).comments, []);
  } finally {
    sqlite.close();
  }
});

void test('revogação concluída durante o envio impede confirmar ou revelar o comentário', async () => {
  const { sqlite, db, owner, guest } = fixture();
  try {
    await owner.registerViewer();
    await guest.registerViewer();
    const doc = await createDocument(owner, {
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
    assert.equal((await owner.comments(doc.id)).comments.length, 1);
  } finally {
    sqlite.close();
  }
});

void test('entrada inválida não grava documentos, compartilhamentos ou comentários', async () => {
  const { sqlite, owner } = fixture();
  try {
    await owner.registerViewer();
    await assert.rejects(
      createDocument(owner, { markdown: ' ', filename: 'vazio.md' }),
    );
    assert.deepEqual(await owner.list(), []);
    const original = '    código com indentação\n\n# Título\n';
    const doc = await createDocument(owner, {
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
    assert.deepEqual((await owner.comments(doc.id)).comments, []);
  } finally {
    sqlite.close();
  }
});

void test('upload manual infere título quando omitido e valida título explícito', async () => {
  const { sqlite, owner } = fixture();
  await owner.registerViewer();
  const inferred = await createDocument(owner, {
    markdown: '# Título do Markdown',
    filename: 'inferido.md',
  });
  const explicit = await createDocument(owner, {
    markdown: 'Sem cabeçalho',
    filename: 'arquivo.md',
    title: 'Título explícito',
  });
  assert.equal(inferred.title, 'Título do Markdown');
  assert.equal(explicit.title, 'Título explícito');
  for (const title of ['', null, [], {}])
    await assert.rejects(
      createDocument(owner, {
        markdown: '# Inválido',
        filename: 'invalido.md',
        title,
      }),
      (error) => error instanceof HttpError && error.status === 400,
    );
  sqlite.close();
});

void test('replay e concorrência da mesma importação convergem em uma linha exata', async () => {
  const { sqlite, db, owner } = fixture();
  try {
    await owner.registerViewer();
    const payload = {
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      markdown: '\n# Importação estável\n\nConteúdo exato.\n',
      filename: 'estavel.md',
    };
    const schedule = pauseConcurrentDocumentInserts(db);
    const concurrentOwner = new DocumentService(schedule.controlled, {
      ...owner.viewer,
    });
    const [first, second] = await Promise.all([
      concurrentOwner.create(payload),
      concurrentOwner.create(payload),
    ]);
    assert.equal(schedule.arrivals(), 2);
    assert.deepEqual(second, first);
    assert.equal(first.id, payload.id);
    assert.equal(first.markdown, payload.markdown);
    assert.equal(
      sqlite
        .prepare('SELECT count(*) n FROM documents WHERE id=?')
        .get(payload.id)?.n,
      1,
    );
    assert.deepEqual(await owner.create(payload), first);
  } finally {
    sqlite.close();
  }
});

void test('mesmo UUID rejeita autor, contexto ou payload divergente sem sobrescrever', async () => {
  const { sqlite, db, owner, guest } = fixture();
  try {
    await owner.registerViewer();
    await guest.registerViewer();
    const payload = {
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      markdown: '# Original',
      filename: 'original.md',
    };
    const original = await owner.create(payload);
    for (const divergent of [
      { ...payload, markdown: '# Alterado' },
      { ...payload, filename: 'alterado.md' },
      { ...payload, title: 'Título explícito' },
    ])
      await assert.rejects(
        owner.create(divergent),
        (error) => error instanceof HttpError && error.status === 409,
      );

    await assert.rejects(
      guest.create({
        ...payload,
        authorId: guest.viewer.id,
        markdown: '# Conteúdo de outro autor',
      }),
      (error) =>
        error instanceof HttpError &&
        error.status === 409 &&
        !error.message.includes(original.markdown),
    );
    const testContext = new DocumentService(db, {
      ...owner.viewer,
      isTest: true,
    });
    await assert.rejects(
      testContext.create(payload),
      (error) => error instanceof HttpError && error.status === 409,
    );
    assert.deepEqual(await owner.document(payload.id), original);
  } finally {
    sqlite.close();
  }
});

void test('importação exige UUID e autor esperado sem gerar identificador alternativo', async () => {
  const { sqlite, owner } = fixture();
  try {
    await owner.registerViewer();
    const base = { markdown: '# Contrato', filename: 'contrato.md' };
    for (const invalid of [
      base,
      { ...base, id: crypto.randomUUID() },
      { ...base, id: ['não escalar'], authorId: owner.viewer.id },
      { ...base, id: 'não-uuid', authorId: owner.viewer.id },
      {
        ...base,
        id: crypto.randomUUID(),
        authorId: owner.viewer.id,
        title: [],
      },
    ])
      await assert.rejects(
        owner.create(invalid),
        (error) => error instanceof HttpError && error.status === 400,
      );
    await assert.rejects(
      owner.create({
        ...base,
        id: crypto.randomUUID(),
        authorId: 'outra-sessão',
      }),
      (error) => error instanceof HttpError && error.status === 409,
    );
    assert.equal(
      sqlite.prepare('SELECT count(*) n FROM documents').get()?.n,
      0,
    );
  } finally {
    sqlite.close();
  }
});

void test('paginação usa sequência persistida sem lacunas, inclusive após janela vazia e inserção tardia', async () => {
  const { sqlite, db, owner, stranger } = fixture();
  try {
    await owner.registerViewer();
    await stranger.registerViewer();
    const doc = await createDocument(owner, {
      markdown: '# Muitas contribuições',
      filename: 'muitas.md',
    });
    const empty = await owner.comments(doc.id);
    assert.deepEqual(empty.comments, []);
    assert.equal(empty.pagination.olderCursor, null);
    assert.equal(empty.pagination.hasMore, false);

    for (let index = 0; index < 205; index += 1)
      await db
        .prepare(
          'INSERT INTO comments(id,document_id,author_id,body,quote,source_start,created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .bind(
          stableCommentId(index + 1000),
          doc.id,
          owner.viewer.id,
          `Comentário ${index}`,
          '',
          null,
          `2026-01-0${(index % 3) + 1}T00:00:00.000Z`,
        )
        .run();

    let nextCursor = empty.pagination.nextCursor;
    const incremental = [];
    const incrementalSizes = [];
    for (;;) {
      const page = await owner.comments(doc.id, { after: nextCursor });
      assert.ok(page.comments.length <= 100);
      assert.equal(page.pagination.olderCursor, null);
      assertVisualOrder(page.comments);
      incremental.push(...page.comments);
      incrementalSizes.push(page.comments.length);
      nextCursor = page.pagination.nextCursor;
      if (!page.pagination.hasMore) break;
    }
    assert.deepEqual(incrementalSizes, [100, 100, 5]);
    assert.equal(new Set(incremental.map((entry) => entry.id)).size, 205);
    assert.equal('sequence' in incremental[0], false);

    const lateId = stableCommentId(0);
    await db
      .prepare(
        'INSERT INTO comments(id,document_id,author_id,body,quote,source_start,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(
        lateId,
        doc.id,
        owner.viewer.id,
        'Inserido depois com timestamp anterior',
        '',
        null,
        '2026-01-01T00:00:00.000Z',
      )
      .run();
    assert.equal(
      (await owner.comment(doc.id, lateId))?.body.startsWith('Inserido'),
      true,
    );
    const latePage = await owner.comments(doc.id, { after: nextCursor });
    assert.deepEqual(
      latePage.comments.map((entry) => entry.id),
      [lateId],
    );

    const latest = await owner.comments(doc.id);
    assert.equal(latest.comments.length, 100);
    assert.ok(latest.pagination.olderCursor);
    assertVisualOrder(latest.comments);
    assert.equal(
      (await owner.comment(doc.id, stableCommentId(1000)))?.body,
      'Comentário 0',
    );
    const concurrentHistoryId = stableCommentId(1);
    await db
      .prepare(
        'INSERT INTO comments(id,document_id,author_id,body,quote,source_start,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(
        concurrentHistoryId,
        doc.id,
        owner.viewer.id,
        'Chegou durante a paginação antiga',
        '',
        null,
        '2026-01-01T00:00:00.000Z',
      )
      .run();
    const historical = [...latest.comments];
    const historicalSizes = [latest.comments.length];
    let olderCursor: string | null = latest.pagination.olderCursor;
    while (olderCursor) {
      const page = await owner.comments(doc.id, { before: olderCursor });
      assert.equal(page.pagination.hasMore, false);
      assertVisualOrder(page.comments);
      historical.push(...page.comments);
      historicalSizes.push(page.comments.length);
      olderCursor = page.pagination.olderCursor;
    }
    assert.deepEqual(historicalSizes, [100, 100, 6]);
    assert.equal(new Set(historical.map((entry) => entry.id)).size, 206);
    assert.equal(
      historical.some((entry) => entry.id === concurrentHistoryId),
      false,
    );
    assert.deepEqual(
      (
        await owner.comments(doc.id, {
          after: latest.pagination.nextCursor,
        })
      ).comments.map((entry) => entry.id),
      [concurrentHistoryId],
    );

    const other = await createDocument(owner, {
      markdown: '# Outro',
      filename: 'outro.md',
    });
    await assert.rejects(
      owner.comments(other.id, { after: empty.pagination.nextCursor }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    await assert.rejects(
      owner.comments(doc.id, { after: latest.pagination.olderCursor! }),
      (error) => error instanceof HttpError && error.status === 400,
    );
    const unsafe = Buffer.from(
      JSON.stringify({
        v: 1,
        d: doc.id,
        k: 'after',
        s: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toString('base64url');
    for (const query of [
      { after: 'not-a-cursor' },
      { after: unsafe },
      { after: nextCursor, before: latest.pagination.olderCursor! },
    ])
      await assert.rejects(
        owner.comments(doc.id, query),
        (error) => error instanceof HttpError && error.status === 400,
      );
    assert.equal(await owner.comment(doc.id, stableCommentId(9999)), null);
    await assert.rejects(
      stranger.comment(doc.id, 'invalid'),
      (error) => error instanceof HttpError && error.status === 404,
    );
  } finally {
    sqlite.close();
  }
});

void test('falha inesperada após INSERT confirmado não é convertida em sucesso', async () => {
  const { sqlite, db, owner } = fixture();
  try {
    await owner.registerViewer();
    const payload = {
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      markdown: '# Persistido sem resposta',
      filename: 'incerto.md',
    };
    const ambiguous = Object.create(db) as D1Database;
    ambiguous.prepare = (sql: string) => {
      const statement = db.prepare(sql);
      if (!sql.startsWith('INSERT INTO documents')) return statement;
      return {
        bind(...values: unknown[]) {
          const bound = statement.bind(...values);
          return {
            async run() {
              await bound.run();
              throw new Error('transport failed after commit');
            },
          };
        },
      } as unknown as D1PreparedStatement;
    };
    const uncertain = new DocumentService(ambiguous, { ...owner.viewer });
    await assert.rejects(
      uncertain.create(payload),
      /transport failed after commit/,
    );
    assert.equal(
      sqlite
        .prepare('SELECT count(*) n FROM documents WHERE id=?')
        .get(payload.id)?.n,
      1,
    );
    assert.equal((await owner.create(payload)).markdown, payload.markdown);
  } finally {
    sqlite.close();
  }
});
