import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocumentService } from '../lib/document-service.ts';
import { PublicationService } from '../lib/publication-service.ts';
import {
  activeShareLimit,
  commentLimit,
  DEFAULT_WRITE_QUOTAS,
  ownedDocumentLimit,
  WriteQuotaError,
  type WriteQuotaEnvironment,
} from '../lib/write-quotas.ts';
import { database } from './fixture.ts';

function documentPayload(ownerId: string, label = crypto.randomUUID()) {
  return {
    id: crypto.randomUUID(),
    authorId: ownerId,
    markdown: `# ${label}`,
    filename: `${label}.md`,
  };
}

function quotaError(status: 409 | 503, code: WriteQuotaError['code']) {
  return (error: unknown) =>
    error instanceof WriteQuotaError &&
    error.status === status &&
    error.code === code;
}

void test('limites padrão e configuração exigem inteiro decimal positivo seguro', () => {
  assert.equal(ownedDocumentLimit({}), DEFAULT_WRITE_QUOTAS.ownedDocuments);
  assert.equal(commentLimit({}), DEFAULT_WRITE_QUOTAS.commentsPerDocument);
  assert.equal(
    activeShareLimit({}),
    DEFAULT_WRITE_QUOTAS.activeSharesPerDocument,
  );
  assert.equal(ownedDocumentLimit({ MAX_OWNED_DOCUMENTS: '250' }), 250);
  for (const value of ['', '0', '-1', '1.5', ' 2', '02', '9007199254740992'])
    assert.throws(
      () => ownedDocumentLimit({ MAX_OWNED_DOCUMENTS: value }),
      quotaError(503, 'quota_configuration_invalid'),
    );
});

void test('importação manual e publicação compartilham a última vaga sem recibo órfão', async (t) => {
  const { sqlite, db } = database();
  t.after(() => sqlite.close());
  const quotas: WriteQuotaEnvironment = { MAX_OWNED_DOCUMENTS: '2' };
  const viewer = {
    id: 'owner',
    name: 'Dona',
    email: 'owner@example.com',
  };
  const documents = new DocumentService(db, viewer, quotas);
  await documents.registerViewer();
  await documents.create(documentPayload(viewer.id, 'manual'));
  const credentialId = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO publishing_tokens(
      id,user_id,name,token_hash,created_at,expires_at,revoked_at
    ) VALUES(?,?,?,?,?,?,NULL)`)
    .bind(
      credentialId,
      viewer.id,
      'Teste',
      'hash-' + credentialId,
      new Date().toISOString(),
      Math.floor(Date.now() / 1000) + 3600,
    )
    .run();
  const publications = new PublicationService(
    db,
    { origin: 'https://docs.example.com' },
    undefined,
    quotas,
  );
  const result = await publications.publish(
    viewer,
    credentialId,
    { markdown: '# API', filename: 'api.md' },
    'last-slot',
  );
  assert.match(result.documentId, /^[0-9a-f-]{36}$/);
  await assert.rejects(
    documents.create(documentPayload(viewer.id, 'blocked-manual')),
    quotaError(409, 'quota_exceeded'),
  );
  await assert.rejects(
    publications.publish(
      viewer,
      credentialId,
      { markdown: '# Blocked', filename: 'blocked.md' },
      'blocked-publication',
    ),
    quotaError(409, 'quota_exceeded'),
  );
  assert.equal(
    sqlite.prepare('SELECT count(*) count FROM documents').get()?.count,
    2,
  );
  assert.equal(
    sqlite.prepare('SELECT count(*) count FROM publications').get()?.count,
    1,
  );
  quotas.MAX_OWNED_DOCUMENTS = 'invalid';
  assert.deepEqual(
    await publications.publish(
      viewer,
      credentialId,
      { markdown: '# API', filename: 'api.md' },
      'last-slot',
    ),
    result,
  );
  await assert.rejects(
    publications.publish(
      viewer,
      credentialId,
      { markdown: '# Invalid config', filename: 'invalid.md' },
      'invalid-config',
    ),
    quotaError(503, 'quota_configuration_invalid'),
  );
});

void test('operações novas concorrentes disputam atomicamente uma única vaga', async (t) => {
  const { sqlite, db } = database();
  t.after(() => sqlite.close());
  const quotas: WriteQuotaEnvironment = {
    MAX_OWNED_DOCUMENTS: '1',
    MAX_COMMENTS_PER_DOCUMENT: '1',
    MAX_ACTIVE_SHARES_PER_DOCUMENT: '1',
  };
  const owner = new DocumentService(
    db,
    { id: 'owner', name: 'Dona', email: 'owner@example.com' },
    quotas,
  );
  await owner.registerViewer();
  const documentRace = await Promise.allSettled([
    owner.create(documentPayload(owner.viewer.id, 'race-a')),
    owner.create(documentPayload(owner.viewer.id, 'race-b')),
  ]);
  assert.deepEqual(
    documentRace.map((result) => result.status).sort(),
    ['fulfilled', 'rejected'],
  );
  const document = documentRace.find(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof owner.create>>> =>
      result.status === 'fulfilled',
  )!.value;
  const commentRace = await Promise.allSettled([
    owner.addComment(document.id, {
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      body: 'A',
    }),
    owner.addComment(document.id, {
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      body: 'B',
    }),
  ]);
  assert.deepEqual(
    commentRace.map((result) => result.status).sort(),
    ['fulfilled', 'rejected'],
  );
  const shareRace = await Promise.allSettled([
    owner.share(document.id, { email: 'a@example.com' }),
    owner.share(document.id, { email: 'b@example.com' }),
  ]);
  assert.deepEqual(
    shareRace.map((result) => result.status).sort(),
    ['fulfilled', 'rejected'],
  );
  for (const rejected of [
    documentRace.find((result) => result.status === 'rejected'),
    commentRace.find((result) => result.status === 'rejected'),
    shareRace.find((result) => result.status === 'rejected'),
  ])
    assert.ok(
      rejected?.status === 'rejected' &&
        quotaError(409, 'quota_exceeded')(rejected.reason),
    );
  assert.equal(sqlite.prepare('SELECT count(*) count FROM documents').get()?.count, 1);
  assert.equal(sqlite.prepare('SELECT count(*) count FROM comments').get()?.count, 1);
  assert.equal(sqlite.prepare('SELECT count(*) count FROM shares').get()?.count, 1);
});

void test('comentários concorrentes respeitam a cota e rejeições não avançam a sequência', async (t) => {
  const { sqlite, db } = database();
  t.after(() => sqlite.close());
  const quotas: WriteQuotaEnvironment = {
    MAX_OWNED_DOCUMENTS: '2',
    MAX_COMMENTS_PER_DOCUMENT: '1',
  };
  const owner = new DocumentService(
    db,
    { id: 'owner', name: 'Dona', email: 'owner@example.com' },
    quotas,
  );
  await owner.registerViewer();
  const document = await owner.create(documentPayload(owner.viewer.id, 'comments'));
  const payload = {
    id: crypto.randomUUID(),
    authorId: owner.viewer.id,
    body: 'Comentário único.',
  };
  const [first, replay] = await Promise.all([
    owner.addComment(document.id, payload),
    owner.addComment(document.id, payload),
  ]);
  assert.deepEqual(replay, first);
  const sequence = sqlite
    .prepare("SELECT seq FROM sqlite_sequence WHERE name='comments'")
    .get()?.seq;
  await assert.rejects(
    owner.addComment(document.id, {
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      body: 'Excedente.',
    }),
    quotaError(409, 'quota_exceeded'),
  );
  assert.equal(
    sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name='comments'").get()
      ?.seq,
    sequence,
  );
  assert.deepEqual(await owner.addComment(document.id, payload), first);
  assert.equal(
    sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name='comments'").get()
      ?.seq,
    sequence,
  );
});

void test('convite existente ignora configuração inválida e revogação libera a vaga', async (t) => {
  const { sqlite, db } = database();
  t.after(() => sqlite.close());
  const quotas: WriteQuotaEnvironment = {
    MAX_OWNED_DOCUMENTS: '2',
    MAX_ACTIVE_SHARES_PER_DOCUMENT: '1',
  };
  const owner = new DocumentService(
    db,
    { id: 'owner', name: 'Dona', email: 'owner@example.com' },
    quotas,
  );
  await owner.registerViewer();
  const document = await owner.create(documentPayload(owner.viewer.id, 'shares'));
  const existing = await owner.share(document.id, {
    email: 'first@example.com',
    name: 'Primeira',
  });
  quotas.MAX_ACTIVE_SHARES_PER_DOCUMENT = 'invalid';
  assert.deepEqual(
    await owner.share(document.id, {
      email: 'first@example.com',
      name: 'Primeira',
    }),
    existing,
  );
  await assert.rejects(
    owner.share(document.id, { email: 'second@example.com' }),
    quotaError(503, 'quota_configuration_invalid'),
  );
  quotas.MAX_ACTIVE_SHARES_PER_DOCUMENT = '1';
  await owner.revoke(document.id, 'first@example.com');
  assert.equal(
    (await owner.share(document.id, { email: 'second@example.com' })).email,
    'second@example.com',
  );
});

void test('replays permanecem recuperáveis com configuração de planos inválida', async (t) => {
  const { sqlite, db } = database();
  t.after(() => sqlite.close());
  const quotas: WriteQuotaEnvironment = { MAX_OWNED_DOCUMENTS: '1' };
  const owner = new DocumentService(
    db,
    { id: 'owner', name: 'Dona', email: 'owner@example.com' },
    quotas,
  );
  await owner.registerViewer();
  const payload = documentPayload(owner.viewer.id, 'recoverable');
  const created = await owner.create(payload);
  quotas.MAX_OWNED_DOCUMENTS = 'invalid';
  assert.deepEqual(await owner.create(payload), created);
  await assert.rejects(
    owner.create(documentPayload(owner.viewer.id, 'new')),
    quotaError(503, 'quota_configuration_invalid'),
  );
  assert.equal((await owner.list()).documents.length, 1);
});
