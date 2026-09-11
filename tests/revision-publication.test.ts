import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DocumentService,
  HttpError,
  type DocumentRow,
  type Viewer,
} from '../lib/document-service.ts';
import { WriteQuotaError } from '../lib/write-quotas.ts';
import { database } from './fixture.ts';

const owner: Viewer = {
  id: 'revision-owner',
  name: 'Autora',
  email: 'author@example.com',
};
const guest: Viewer = {
  id: 'revision-guest',
  name: 'Pessoa convidada',
  email: 'guest@example.com',
};

async function fixture(environment: { MAX_REVISIONS_PER_DOCUMENT?: string } = {}) {
  const store = database();
  const service = new DocumentService(store.db, { ...owner }, environment);
  const guestService = new DocumentService(store.db, { ...guest }, environment);
  await Promise.all([service.registerViewer(), guestService.registerViewer()]);
  const document = await service.create({
    id: crypto.randomUUID(),
    authorId: owner.id,
    markdown: '# v1\n\nTrecho inicial.\n',
    filename: 'plano.md',
  });
  return { ...store, service, guestService, document };
}

function payload(
  document: DocumentRow,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: crypto.randomUUID(),
    baseRevisionId: document.current_revision_id,
    markdown: '# v2\r\n\r\nNovo conteúdo.\r\n',
    filename: 'plano-v2.md',
    summary: 'Aplica as críticas selecionadas.',
    consideredCommentIds: [],
    ...overrides,
  };
}

void test('publica snapshot, avança projeção e preserva referências exatas ordenadas', async (t) => {
  const f = await fixture();
  t.after(() => f.sqlite.close());
  await f.service.share(f.document.id, { email: guest.email, name: guest.name });
  const legacyReplyId = '018f47a2-7b3c-7abc-8def-1234567890ab';
  const rootId = crypto.randomUUID();
  const root = await f.guestService.addComment(f.document.id, {
    id: rootId,
    authorId: guest.id,
    body: 'Ajuste esta premissa.',
    quote: 'Trecho inicial.',
    sourceStart: 6,
    sourceRevisionId: f.document.current_revision_id,
  });
  const reply = await f.service.addComment(f.document.id, {
    id: legacyReplyId,
    authorId: owner.id,
    body: 'Vou considerar só esta resposta.',
    rootId,
  });
  const request = payload(f.document, {
    id: crypto.randomUUID(),
    consideredCommentIds: [reply.id, root.id, reply.id],
  });

  const result = await f.service.createRevision(f.document.id, request);
  assert.equal(result.replayed, false);
  assert.equal(result.revision.ordinal, 2);
  assert.equal(result.revision.author_id, owner.id);
  assert.equal(result.revision.base_revision_id, f.document.current_revision_id);
  assert.equal(result.revision.markdown, request.markdown);
  assert.deepEqual(result.revision.considered_comment_ids, [reply.id, root.id].sort());
  assert.deepEqual(
    result.revision.considered_comments.map((comment) => ({
      id: comment.id,
      root_id: comment.root_id,
      author_id: comment.author_id,
      author_name: comment.author_name,
    })),
    [reply.id, root.id]
      .sort()
      .map((id) => (id === root.id ? root : reply))
      .map((comment) => ({
        id: comment.id,
        root_id: comment.root_id,
        author_id: comment.author_id,
        author_name: comment.author_name,
      })),
  );
  const current = await f.service.document(f.document.id);
  assert.equal(current.current_revision_id, request.id);
  assert.equal(current.markdown, request.markdown);
  assert.equal(current.filename, request.filename);
  assert.equal(
    f.sqlite
      .prepare('SELECT count(*) AS count FROM conversation_events')
      .get()?.count,
    0,
  );
});

void test('aceita o limite público de 100 referências com consulta JSON de poucos binds', async (t) => {
  const f = await fixture();
  t.after(() => f.sqlite.close());
  await f.service.share(f.document.id, { email: guest.email, name: guest.name });
  const commentIds: string[] = [];
  for (let index = 0; index < 100; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    commentIds.push(id);
    await f.guestService.addComment(f.document.id, {
      id,
      authorId: guest.id,
      body: `Crítica ${index}`,
      quote: '',
      sourceStart: null,
      sourceRevisionId: f.document.current_revision_id,
    });
  }
  const result = await f.service.createRevision(
    f.document.id,
    payload(f.document, { consideredCommentIds: commentIds.toReversed() }),
  );
  assert.deepEqual(result.revision.considered_comment_ids, commentIds);
  assert.deepEqual(
    result.revision.considered_comments.map((comment) => comment.id),
    commentIds,
  );
});

void test('replay exato vence base antiga e configuração de cota inválida', async (t) => {
  const f = await fixture();
  t.after(() => f.sqlite.close());
  const firstRequest = payload(f.document);
  const first = await f.service.createRevision(f.document.id, firstRequest);
  const secondRequest = payload(await f.service.document(f.document.id), {
    markdown: '# v3',
    filename: 'plano-v3.md',
  });
  await f.service.createRevision(f.document.id, secondRequest);

  const invalidQuota = new DocumentService(f.db, { ...owner }, {
    MAX_REVISIONS_PER_DOCUMENT: 'invalid',
  });
  const replay = await invalidQuota.createRevision(f.document.id, firstRequest);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.revision, first.revision);
  assert.equal((await f.service.document(f.document.id)).current_revision_id, secondRequest.id);
  await assert.rejects(
    invalidQuota.createRevision(
      f.document.id,
      payload(await f.service.document(f.document.id)),
    ),
    (error) =>
      error instanceof WriteQuotaError &&
      error.status === 503 &&
      error.code === 'quota_configuration_invalid',
  );
});

void test('UUID reutilizado com qualquer payload diferente conflita sem alterar recibo', async (t) => {
  const f = await fixture();
  t.after(() => f.sqlite.close());
  const request = payload(f.document);
  const first = await f.service.createRevision(f.document.id, request);
  await assert.rejects(
    f.service.createRevision(f.document.id, {
      ...request,
      consideredCommentIds: [crypto.randomUUID()],
    }),
    (error) => error instanceof HttpError && error.status === 409,
  );
  assert.deepEqual((await f.service.revision(f.document.id, request.id as string)), first.revision);
});

void test('duas publicações na mesma base produzem um avanço e um conflito', async (t) => {
  const f = await fixture();
  t.after(() => f.sqlite.close());
  const results = await Promise.allSettled([
    f.service.createRevision(f.document.id, payload(f.document, { markdown: '# A' })),
    f.service.createRevision(f.document.id, payload(f.document, { markdown: '# B' })),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.reason instanceof HttpError);
  assert.equal(rejected.reason.status, 409);
  assert.equal(
    f.sqlite
      .prepare('SELECT count(*) AS count FROM document_revisions WHERE document_id=?')
      .get(f.document.id)?.count,
    2,
  );
  assert.equal(
    f.sqlite
      .prepare(
        "SELECT count(*) AS count FROM notification_events WHERE document_id=? AND kind='revision'",
      )
      .get(f.document.id)?.count,
    1,
  );
});

void test('referência ausente ou alheia falha sem snapshot nem avanço', async (t) => {
  const f = await fixture();
  t.after(() => f.sqlite.close());
  const other = await f.service.create({
    id: crypto.randomUUID(),
    authorId: owner.id,
    markdown: '# Outro',
    filename: 'outro.md',
  });
  const foreign = await f.service.addComment(other.id, {
    id: crypto.randomUUID(),
    authorId: owner.id,
    body: 'Comentário de outro plano.',
    sourceRevisionId: other.current_revision_id,
  });
  for (const commentId of [foreign.id, crypto.randomUUID()]) {
    const request = payload(f.document, { consideredCommentIds: [commentId] });
    await assert.rejects(
      f.service.createRevision(f.document.id, request),
      (error) => error instanceof HttpError && error.status === 409,
    );
    assert.equal(await f.service.revision(f.document.id, request.id as string).catch(() => null), null);
  }
  assert.equal((await f.service.document(f.document.id)).current_revision_id, f.document.id);
  assert.equal(
    f.sqlite
      .prepare(
        "SELECT count(*) AS count FROM notification_events WHERE document_id=? AND kind='revision'",
      )
      .get(f.document.id)?.count,
    0,
  );
});

void test('cota conta a inicial e trigger impede snapshot sem avanço CAS', async (t) => {
  const f = await fixture({ MAX_REVISIONS_PER_DOCUMENT: '2' });
  t.after(() => f.sqlite.close());
  const first = payload(f.document);
  await f.service.createRevision(f.document.id, first);
  await assert.rejects(
    f.service.createRevision(
      f.document.id,
      payload(await f.service.document(f.document.id)),
    ),
    (error) =>
      error instanceof WriteQuotaError &&
      error.status === 409 &&
      error.code === 'quota_exceeded',
  );
  assert.throws(
    () =>
      f.sqlite
        .prepare(
          `INSERT INTO document_revisions
           (id,document_id,ordinal,author_id,title,filename,markdown,base_revision_id,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          crypto.randomUUID(),
          f.document.id,
          3,
          owner.id,
          'órfã',
          'orfa.md',
          '# órfã',
          f.document.id,
          new Date().toISOString(),
        ),
    /document revision advance conflict/,
  );
  assert.equal(
    f.sqlite
      .prepare('SELECT count(*) AS count FROM document_revisions WHERE document_id=?')
      .get(f.document.id)?.count,
    2,
  );
  assert.equal(
    f.sqlite
      .prepare(
        "SELECT count(*) AS count FROM notification_events WHERE document_id=? AND kind='revision'",
      )
      .get(f.document.id)?.count,
    1,
  );
});

void test('replay da importação inicial após v2 e v3 retorna v1 sem regredir atual', async (t) => {
  const f = await fixture();
  t.after(() => f.sqlite.close());
  const v2 = payload(f.document);
  await f.service.createRevision(f.document.id, v2);
  const v3 = payload(await f.service.document(f.document.id), {
    markdown: '# v3',
    filename: 'plano-v3.md',
  });
  await f.service.createRevision(f.document.id, v3);
  const receipt = await f.service.create({
    id: f.document.id,
    authorId: owner.id,
    markdown: f.document.markdown,
    filename: f.document.filename,
  });
  assert.equal(receipt.current_revision_id, f.document.id);
  assert.equal(receipt.revision_ordinal, 1);
  assert.equal(receipt.markdown, f.document.markdown);
  const current = await f.service.document(f.document.id);
  assert.equal(current.current_revision_id, v3.id);
  assert.equal(current.markdown, '# v3');
});
