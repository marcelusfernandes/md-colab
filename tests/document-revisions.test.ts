import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocumentService, HttpError } from '../lib/document-service.ts';
import { database } from './fixture.ts';

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
  return { sqlite, db, owner, guest };
}

async function createDocument(
  service: DocumentService,
  fields: { markdown: string; filename: string },
) {
  return service.create({
    id: crypto.randomUUID(),
    authorId: service.viewer.id,
    ...fields,
  });
}

function addSecondRevision(
  sqlite: ReturnType<typeof database>['sqlite'],
  documentId: string,
  authorId: string,
  markdown = '# v2',
) {
  const revisionId = crypto.randomUUID();
  sqlite
    .prepare(
      `INSERT INTO document_revisions
       (id,document_id,ordinal,author_id,title,filename,markdown,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    )
    .run(
      revisionId,
      documentId,
      2,
      authorId,
      'v2',
      'plano.md',
      markdown,
      '2026-09-11T12:00:00.000Z',
    );
  sqlite
    .prepare(
      `UPDATE documents SET current_revision_id=?,title=?,filename=?,markdown=?
       WHERE id=?`,
    )
    .run(revisionId, 'v2', 'plano.md', markdown, documentId);
  return revisionId;
}

void test('criação manual e de teste persiste snapshot inicial exato e leitura coerente', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await f.owner.registerViewer();
  const markdown = '\uFEFF# Plano\r\n\r\nConteúdo original.\r\n';
  const document = await createDocument(f.owner, {
    markdown,
    filename: 'plano.md',
  });
  assert.equal(document.current_revision_id, document.id);
  assert.equal(document.revision_ordinal, 1);
  assert.equal(document.revision_author_id, f.owner.viewer.id);
  assert.equal(document.revision_created_at, document.created_at);
  assert.equal(document.markdown, markdown);
  assert.deepEqual(
    { ...(await f.owner.revision(document.id, document.id)) },
    {
      id: document.id,
      document_id: document.id,
      ordinal: 1,
      author_id: f.owner.viewer.id,
      title: document.title,
      filename: document.filename,
      markdown,
      created_at: document.created_at,
    },
  );

  const testOwner = new DocumentService(f.db, {
    id: 'test-owner',
    name: 'Teste',
    email: 'declared@qa.invalid',
    isTest: true,
  });
  await testOwner.registerViewer();
  const testDocument = await createDocument(testOwner, {
    markdown: '# Teste',
    filename: 'teste.md',
  });
  assert.equal(testDocument.current_revision_id, testDocument.id);
  assert.equal(testDocument.is_test, 1);
});

void test('leitura de revisão segue acesso do plano, revogação e vínculo documental', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await Promise.all([f.owner.registerViewer(), f.guest.registerViewer()]);
  const first = await createDocument(f.owner, {
    markdown: '# Primeiro',
    filename: 'primeiro.md',
  });
  const second = await createDocument(f.owner, {
    markdown: '# Segundo',
    filename: 'segundo.md',
  });
  await f.owner.share(first.id, { email: f.guest.viewer.email });
  assert.equal(
    (await f.guest.revision(first.id, first.id)).markdown,
    '# Primeiro',
  );
  await assert.rejects(
    f.guest.revision(first.id, second.id),
    (error) => error instanceof HttpError && error.status === 404,
  );
  await assert.rejects(
    f.guest.revision(first.id, 'malformed'),
    (error) => error instanceof HttpError && error.status === 400,
  );
  await f.owner.revoke(first.id, f.guest.viewer.email);
  await assert.rejects(
    f.guest.revision(first.id, first.id),
    (error) => error instanceof HttpError && error.status === 404,
  );
});

void test('origem explícita usa snapshot visto; replay e reply preservam a raiz antiga', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await f.owner.registerViewer();
  const v1Markdown = '# v1\n\n' + 'conteúdo antigo '.repeat(12);
  const document = await createDocument(f.owner, {
    markdown: v1Markdown,
    filename: 'plano.md',
  });
  const v1 = document.current_revision_id;
  const v2 = addSecondRevision(f.sqlite, document.id, f.owner.viewer.id);
  const current = await f.owner.document(document.id);
  assert.equal(current.current_revision_id, v2);
  assert.equal(current.markdown, '# v2');
  assert.equal((await f.owner.revision(document.id, v1)).markdown, v1Markdown);

  const rootPayload = {
    id: crypto.randomUUID(),
    authorId: f.owner.viewer.id,
    body: 'Crítica formada em v1.',
    quote: 'conteúdo antigo',
    sourceStart: 97,
    sourceRevisionId: v1,
  };
  const root = await f.owner.addComment(document.id, rootPayload);
  assert.equal(root.source_revision_id, v1);
  assert.deepEqual(
    await f.owner.addComment(document.id, {
      ...rootPayload,
      sourceRevisionId: undefined,
    }),
    root,
    'replay resolve a origem persistida antes de validar o offset contra v2 curta',
  );
  await assert.rejects(
    f.owner.addComment(document.id, { ...rootPayload, sourceRevisionId: v2 }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  await assert.rejects(
    f.owner.addComment(document.id, {
      id: crypto.randomUUID(),
      authorId: f.owner.viewer.id,
      body: 'Cliente antigo ambíguo.',
    }),
    (error) => error instanceof HttpError && error.status === 409,
  );

  const reply = await f.owner.addComment(document.id, {
    id: crypto.randomUUID(),
    authorId: f.owner.viewer.id,
    body: 'Resposta na conversa antiga.',
    rootId: root.id,
  });
  assert.equal(reply.source_revision_id, v1);
  await assert.rejects(
    f.owner.addComment(document.id, {
      id: crypto.randomUUID(),
      authorId: f.owner.viewer.id,
      body: 'Resposta com origem trocada.',
      rootId: root.id,
      sourceRevisionId: v2,
    }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  assert.ok(
    (await f.owner.comments(document.id)).comments.every(
      (comment) => comment.source_revision_id === v1,
    ),
  );
});

void test('fallback de revisão única é revalidado atomicamente no INSERT', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await f.owner.registerViewer();
  const document = await createDocument(f.owner, {
    markdown: '# v1',
    filename: 'plano.md',
  });
  let insertedConcurrentRevision = false;
  const controlled = Object.create(f.db) as D1Database;
  controlled.prepare = (sql: string) => {
    const statement = f.db.prepare(sql);
    if (!sql.startsWith('INSERT INTO comments')) return statement;
    return {
      bind(...values: unknown[]) {
        const bound = statement.bind(...values);
        return {
          async run() {
            addSecondRevision(f.sqlite, document.id, f.owner.viewer.id);
            insertedConcurrentRevision = true;
            return bound.run();
          },
        };
      },
    } as unknown as D1PreparedStatement;
  };
  const service = new DocumentService(controlled, { ...f.owner.viewer });
  await assert.rejects(
    service.addComment(document.id, {
      id: crypto.randomUUID(),
      authorId: f.owner.viewer.id,
      body: 'Sem origem explícita.',
    }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  assert.equal(insertedConcurrentRevision, true);
  assert.equal(
    f.sqlite.prepare('SELECT count(*) AS count FROM comments').get()?.count,
    0,
  );
});

void test('falha do batch de importação não deixa documento nem revisão órfã', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await f.owner.registerViewer();
  const documentId = crypto.randomUUID();
  const failing = Object.create(f.db) as D1Database;
  failing.batch = (statements) =>
    f.db.batch([
      ...statements,
      f.db.prepare('INSERT INTO missing_revision_test VALUES (1)'),
    ]);
  const service = new DocumentService(failing, { ...f.owner.viewer });
  await assert.rejects(
    service.create({
      id: documentId,
      authorId: f.owner.viewer.id,
      markdown: '# Falha',
      filename: 'falha.md',
    }),
    /missing_revision_test/,
  );
  assert.equal(
    f.sqlite
      .prepare('SELECT count(*) AS count FROM documents WHERE id=?')
      .get(documentId)?.count,
    0,
  );
  assert.equal(
    f.sqlite
      .prepare(
        'SELECT count(*) AS count FROM document_revisions WHERE document_id=?',
      )
      .get(documentId)?.count,
    0,
  );
});

void test('snapshots persistidos recusam update e delete', async (t) => {
  const f = fixture();
  t.after(() => f.sqlite.close());
  await f.owner.registerViewer();
  const document = await createDocument(f.owner, {
    markdown: '# Imutável',
    filename: 'imutavel.md',
  });
  assert.throws(
    () =>
      f.sqlite
        .prepare('UPDATE document_revisions SET markdown=? WHERE id=?')
        .run('# Alterado', document.current_revision_id),
    /document revisions are immutable/,
  );
  assert.throws(
    () =>
      f.sqlite
        .prepare('DELETE FROM document_revisions WHERE id=?')
        .run(document.current_revision_id),
    /document revisions are immutable/,
  );
});
