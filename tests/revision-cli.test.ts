import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import {
  CliError,
  createOperation,
  parseArguments,
  run,
  validateContext,
  validateOperation,
} from '../scripts/md-colab-revise.mjs';

const origin = 'https://docs.example.com';
const documentId = '10000000-0000-4000-8000-000000000001';
const baseRevisionId = '20000000-0000-4000-8000-000000000002';
const authorId = '30000000-0000-4000-8000-000000000003';
const token = `mdp_${'a'.repeat(64)}`;
const operations = { chmod, link, lstat, mkdir, open, rename, unlink };

function environment(planToken = token): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: 'test', MD_COLAB_PLAN_TOKEN: planToken };
}

function sha256(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex');
}

function uuid(index: number) {
  return `40000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'md-colab-revise-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function context(commentCount = 0) {
  const comments = Array.from({ length: commentCount }, (_, index) => {
    const id = uuid(index + 1);
    return {
      id,
      root_id: id,
      author_id: uuid(500 + index),
      author_name: `Pessoa ${index + 1}`,
      body: `Crítica ${index + 1}`,
      quote: '',
      source_start: index,
      source_revision_id: baseRevisionId,
      created_at: new Date(Date.UTC(2026, 8, 11, 0, 0, index)).toISOString(),
      is_root: true,
      conversation: {
        state: 'open',
        version: 0,
        decision: null,
        decision_reason: null,
        reply_count: 0,
      },
    };
  });
  return {
    schema_version: 1,
    origin,
    export: {
      complete: true,
      validated_at: '2026-09-11T03:00:00.000Z',
      snapshot_coverage: 'current_and_comment_origins',
      full_revision_history: false,
    },
    semantics: {
      source_start: 'renderer_block_anchor',
      closed_conversation_is_approval: false,
      execution_authorized: false,
      considered_comment_ids: 'author_marked_as_considered',
    },
    document: {
      id: documentId,
      title: 'Plano atual',
      filename: 'atual.md',
      current_revision_id: baseRevisionId,
      current_revision_ordinal: 2,
      counts: { comments: commentCount, events: 0, revisions: 2 },
    },
    comments,
    events: [] as Array<Record<string, unknown>>,
    revisions: [
      {
        id: baseRevisionId,
        document_id: documentId,
        ordinal: 2,
        author_id: authorId,
        author_name: 'Autora',
        title: 'Plano atual',
        filename: 'atual.md',
        base_revision_id: documentId,
        summary: null,
        considered_comment_ids: [],
        created_at: '2026-09-11T02:00:00.000Z',
        file: `revision-${sha256(baseRevisionId)}.md`,
        byte_length: 13,
        sha256: 'b'.repeat(64),
      },
    ],
    comparison: { status: 'not_compared', revision_id: baseRevisionId },
  };
}

function receipt(operation: ReturnType<typeof createOperation>) {
  return {
    revision: {
      id: operation.revisionId,
      document_id: operation.documentId,
      ordinal: 3,
      author_id: authorId,
      title: operation.payload.title,
      filename: operation.payload.filename,
      markdown: operation.payload.markdown,
      base_revision_id: operation.payload.baseRevisionId,
      summary: operation.payload.summary,
      considered_comment_ids: operation.payload.consideredCommentIds,
      considered_comments: operation.payload.consideredCommentIds.map(
        (id: string) => ({
          id,
          root_id: id,
          source_revision_id: baseRevisionId,
          author_id: authorId,
          author_name: 'Pessoa observada',
          body: 'Conteúdo tratado como dado',
          quote: '',
          created_at: '2026-09-11T01:00:00.000Z',
        }),
      ),
      created_at: '2026-09-11T04:00:00.000Z',
    },
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function publishArguments(directory: string, references: string[] = []) {
  return [
    '--action',
    'publish',
    '--origin',
    origin,
    '--document',
    documentId,
    '--operation',
    join(directory, 'operation.json'),
    '--context',
    join(directory, 'context.json'),
    '--file',
    join(directory, 'proposta.md'),
    '--summary',
    '  Síntese da proposta  ',
    ...references.flatMap((id) => ['--considered-comment', id]),
  ];
}

void test('publish congela payload completo; retry e lookup usam somente a operação com token rotacionado', async (t) => {
  const directory = await temporary(t);
  const source = context(100);
  const references = source.comments.map((comment) => comment.id).reverse();
  await writeFile(join(directory, 'context.json'), JSON.stringify(source));
  const markdown = '# Título derivado com espaços   \n\nLinha Unicode ç.\r\n';
  await writeFile(join(directory, 'proposta.md'), markdown);
  const requests: Array<{ url: URL; init: RequestInit; body: unknown }> = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ url, init: init ?? {}, body });
    const operation = validateOperation(
      JSON.parse(await readFile(join(directory, 'operation.json'), 'utf8')),
    );
    return json(receipt(operation), init?.method === 'POST' ? 201 : 200);
  };
  const outputs: unknown[] = [];
  await run(
    publishArguments(directory, [...references, references[0]]),
    environment(),
    {
      fetchImpl,
      stdout: async (value) => {
        outputs.push(value);
      },
    },
  );
  const operationPath = join(directory, 'operation.json');
  const stored = validateOperation(
    JSON.parse(await readFile(operationPath, 'utf8')),
  );
  assert.equal((await stat(operationPath)).mode & 0o777, 0o600);
  assert.equal(stored.payload.markdown, markdown);
  assert.equal(stored.payload.filename, 'proposta.md');
  assert.equal(stored.payload.title, 'Título derivado com espaços');
  assert.equal(stored.payload.summary, 'Síntese da proposta');
  assert.deepEqual(stored.payload.consideredCommentIds, [...references].sort());
  assert.equal(JSON.stringify(stored).includes(token), false);
  assert.equal(Object.hasOwn(stored, 'credentialFingerprint'), false);
  assert.deepEqual(requests[0].body, {
    id: stored.revisionId,
    baseRevisionId,
    markdown,
    filename: 'proposta.md',
    title: 'Título derivado com espaços',
    summary: 'Síntese da proposta',
    consideredCommentIds: [...references].sort(),
  });
  const firstRecordedAt = stored.receipt.recordedAt;

  await rm(join(directory, 'context.json'));
  await rm(join(directory, 'proposta.md'));
  const common = [
    '--origin',
    origin,
    '--document',
    documentId,
    '--operation',
    operationPath,
  ];
  await run(
    ['--action', 'retry', ...common],
    environment(`mdp_${'c'.repeat(64)}`),
    {
      fetchImpl,
      stdout: async (value) => {
        outputs.push(value);
      },
    },
  );
  await run(
    ['--action', 'lookup', ...common],
    environment(`mdp_${'d'.repeat(64)}`),
    {
      fetchImpl,
      stdout: async (value) => {
        outputs.push(value);
      },
    },
  );
  assert.deepEqual(
    requests.map((request) => request.init.method),
    ['POST', 'POST', 'GET'],
  );
  assert.deepEqual(requests[1].body, requests[0].body);
  assert.equal(requests[2].body, null);
  assert.equal(
    requests[2].url.pathname,
    `/api/agent/documents/${documentId}/revisions/${stored.revisionId}`,
  );
  assert.equal(
    validateOperation(JSON.parse(await readFile(operationPath, 'utf8'))).receipt
      .recordedAt,
    firstRecordedAt,
  );
  assert.equal(outputs.length, 3);
  assert.deepEqual(outputs.at(-1), {
    action: 'lookup',
    origin,
    documentId,
    revisionId: stored.revisionId,
    ordinal: 3,
    baseRevisionId,
    url: `${origin}/d/${documentId}?revision=${stored.revisionId}`,
    operation: resolve(operationPath),
  });
});

void test('duas ações publish no mesmo destino criam uma identidade e somente a vencedora envia POST', async (t) => {
  const directory = await temporary(t);
  await writeFile(join(directory, 'context.json'), JSON.stringify(context()));
  await writeFile(join(directory, 'proposta.md'), '# Concorrente\n');
  const operationPath = resolve(join(directory, 'operation.json'));
  let probes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const controlled = {
    ...operations,
    async lstat(path: string) {
      if (resolve(path) === operationPath && probes < 2) {
        probes += 1;
        if (probes === 2) release();
        await gate;
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return lstat(path);
    },
  } as unknown as typeof operations;
  let posts = 0;
  const fetchImpl = async () => {
    posts += 1;
    const operation = validateOperation(
      JSON.parse(await readFile(operationPath, 'utf8')),
    );
    return json(receipt(operation), 201);
  };
  const results = await Promise.allSettled([
    run(publishArguments(directory), environment(), {
      operations: controlled,
      fetchImpl,
      stdout: async () => {},
    }),
    run(publishArguments(directory), environment(), {
      operations: controlled,
      fetchImpl,
      stdout: async () => {},
    }),
  ]);
  assert.equal(posts, 1);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  const rejected = results.find((result) => result.status === 'rejected');
  assert.match(String(rejected?.reason), /Outra invocação criou a operação/);
  validateOperation(JSON.parse(await readFile(operationPath, 'utf8')));
});

void test('contexto completo recusa contagens, raízes, transições, cobertura e origem divergentes', () => {
  const valid = context(1);
  assert.equal(
    validateContext(structuredClone(valid), origin, documentId).document.id,
    documentId,
  );
  const cases = [
    (value: ReturnType<typeof context>) => (value.document.counts.comments = 2),
    (value: ReturnType<typeof context>) =>
      (value.comments[0].root_id = uuid(999)),
    (value: ReturnType<typeof context>) =>
      value.events.push({
        id: uuid(800),
        root_id: value.comments[0].id,
        actor_id: authorId,
        actor_name: 'Autora',
        base_version: 4,
        version: 5,
        action: 'close',
        state: 'closed',
        decision: null,
        decision_reason: null,
        reason: 'Observado',
        created_at: '2026-09-11T04:00:00.000Z',
      }),
    (value: ReturnType<typeof context>) => {
      const event = {
        id: uuid(801),
        root_id: value.comments[0].id,
        actor_id: authorId,
        actor_name: 'Autora',
        base_version: 0,
        version: 1,
        action: 'close',
        state: 'closed',
        decision: null,
        decision_reason: null,
        reason: 'Observado',
        created_at: '2026-09-11T04:00:00Z',
      };
      value.events.push(event, { ...event });
      value.document.counts.events = 2;
    },
    (value: ReturnType<typeof context>) => value.revisions.pop(),
    (value: ReturnType<typeof context>) =>
      (value.origin = 'https://other.example.com'),
  ];
  for (const mutate of cases) {
    const value = structuredClone(valid);
    mutate(value);
    assert.throws(() => validateContext(value, origin, documentId), CliError);
  }
});

void test('lookup/retry recusam flags mutáveis e alvos divergentes antes da rede', async (t) => {
  assert.throws(
    () =>
      parseArguments([
        '--action',
        'lookup',
        '--origin',
        origin,
        '--document',
        documentId,
        '--operation',
        'op.json',
        '--file',
        'novo.md',
      ]),
    /não aceitam arquivo/,
  );
  const directory = await temporary(t);
  const markdown = Buffer.from('# Operação\n');
  const operation = createOperation({
    origin,
    documentId,
    context: context(),
    markdown: markdown.toString(),
    bytes: markdown,
    file: 'plano.md',
    title: undefined,
    summary: undefined,
    consideredCommentIds: [],
  });
  const operationPath = join(directory, 'operation.json');
  await writeFile(operationPath, JSON.stringify(operation));
  let requests = 0;
  await assert.rejects(
    run(
      [
        '--action',
        'lookup',
        '--origin',
        origin,
        '--document',
        '50000000-0000-4000-8000-000000000005',
        '--operation',
        operationPath,
      ],
      environment(),
      {
        fetchImpl: async () => {
          requests += 1;
          return json({}, 200);
        },
      },
    ),
    /plano diverge/,
  );
  assert.equal(requests, 0);
});

void test('arquivos não regulares, links, crescimento e limites falham antes da rede e da operação', async (t) => {
  const directory = await temporary(t);
  const contextPath = join(directory, 'context.json');
  const markdownPath = join(directory, 'proposta.md');
  const operationPath = join(directory, 'operation.json');
  await writeFile(contextPath, JSON.stringify(context()));
  await writeFile(markdownPath, '# A\n');
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return json({}, 500);
  };
  const linkedOperation = join(directory, 'linked-operation.json');
  await symlink(markdownPath, linkedOperation);
  await assert.rejects(
    run(
      [
        '--action',
        'lookup',
        '--origin',
        origin,
        '--document',
        documentId,
        '--operation',
        linkedOperation,
      ],
      environment(),
      { fetchImpl },
    ),
    /não é um arquivo regular/,
  );
  const fifoOperation = join(directory, 'fifo-operation.json');
  execFileSync('mkfifo', [fifoOperation]);
  await assert.rejects(
    run(
      [
        '--action',
        'lookup',
        '--origin',
        origin,
        '--document',
        documentId,
        '--operation',
        fifoOperation,
      ],
      environment(),
      { fetchImpl },
    ),
    /não é um arquivo regular/,
  );
  const oversizedOperation = join(directory, 'oversized-operation.json');
  await writeFile(oversizedOperation, 'x');
  await truncate(oversizedOperation, 8 * 1024 * 1024 + 1);
  await assert.rejects(
    run(
      [
        '--action',
        'lookup',
        '--origin',
        origin,
        '--document',
        documentId,
        '--operation',
        oversizedOperation,
      ],
      environment(),
      { fetchImpl },
    ),
    /excede o limite local/,
  );
  const oversizedContext = join(directory, 'oversized-context.json');
  await writeFile(oversizedContext, 'x');
  await truncate(oversizedContext, 256 * 1024 * 1024 + 1);
  const contextArgs = publishArguments(directory);
  contextArgs[contextArgs.indexOf(contextPath)] = oversizedContext;
  await assert.rejects(
    run(contextArgs, environment(), { fetchImpl }),
    /excede o limite local/,
  );
  const linkedMarkdown = join(directory, 'linked.md');
  await symlink(markdownPath, linkedMarkdown);
  const linkedArgs = publishArguments(directory);
  linkedArgs[linkedArgs.indexOf(markdownPath)] = linkedMarkdown;
  await assert.rejects(
    run(linkedArgs, environment(), { fetchImpl }),
    /não é um arquivo regular/,
  );
  const growingOperations = {
    ...operations,
    async open(path: string, flags: string | number, mode?: number) {
      const handle = await open(path, flags, mode);
      if (resolve(path) !== resolve(markdownPath)) return handle;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property !== 'stat')
            return Reflect.get(target, property, receiver);
          return async () => {
            const result = await target.stat();
            await appendFile(markdownPath, Buffer.alloc(1024 * 1024 + 1));
            return result;
          };
        },
      });
    },
  } as unknown as typeof operations;
  await assert.rejects(
    run(publishArguments(directory), environment(), {
      operations: growingOperations,
      fetchImpl,
    }),
    /excede o limite local/,
  );
  await writeFile(markdownPath, `# A\n${'\0'.repeat(360_000)}`);
  await assert.rejects(
    run(publishArguments(directory), environment(), { fetchImpl }),
    /payload JSON excede 2 MiB/,
  );
  assert.equal(requests, 0);
  await assert.rejects(lstat(operationPath), /ENOENT/);
});

void test('BOM, CRLF e Unicode são preservados no payload congelado', async (t) => {
  const directory = await temporary(t);
  await writeFile(join(directory, 'context.json'), JSON.stringify(context()));
  const markdown = '\ufeff# Título\r\n\r\nLinha ç.\r\n';
  await writeFile(join(directory, 'proposta.md'), markdown);
  let observedMarkdown = '';
  await run(
    [...publishArguments(directory), '--title', 'Título explícito'],
    environment(),
    {
      fetchImpl: async (_input, init) => {
        const body = init?.body;
        assert.equal(typeof body, 'string');
        observedMarkdown = JSON.parse(body as string).markdown;
        const operation = validateOperation(
          JSON.parse(await readFile(join(directory, 'operation.json'), 'utf8')),
        );
        return json(receipt(operation), 201);
      },
      stdout: async () => {},
    },
  );
  assert.equal(observedMarkdown, markdown);
});

void test('título derivado é truncado, aparado e nunca corta um par surrogate', () => {
  const repeated = 'a'.repeat(239);
  for (const [heading, expected] of [
    [`${repeated} tail`, repeated],
    [`${repeated}😀`, repeated],
  ]) {
    const markdown = `# ${heading}\n`;
    const bytes = Buffer.from(markdown);
    const operation = createOperation({
      origin,
      documentId,
      context: context(),
      markdown,
      bytes,
      file: 'proposta.md',
      title: undefined,
      summary: undefined,
      consideredCommentIds: [],
    });
    assert.equal(operation.payload.title, expected);
    assert.equal(operation.payload.title.length, 239);
    assert.equal(operation.payload.title.endsWith(' '), false);
    validateOperation(operation);
  }
});

void test('404 de lookup e recibo divergente preservam a operação sem requisição implícita', async (t) => {
  const directory = await temporary(t);
  const bytes = Buffer.from('# Proposta\n');
  const operation = createOperation({
    origin,
    documentId,
    context: context(),
    markdown: bytes.toString(),
    bytes,
    file: 'proposta.md',
    title: undefined,
    summary: undefined,
    consideredCommentIds: [],
  });
  const operationPath = join(directory, 'operation.json');
  await writeFile(operationPath, JSON.stringify(operation));
  const args = [
    '--action',
    'lookup',
    '--origin',
    origin,
    '--document',
    documentId,
    '--operation',
    operationPath,
  ];
  let calls = 0;
  await assert.rejects(
    run(args, environment(), {
      fetchImpl: async () => {
        calls += 1;
        return json({}, 404);
      },
    }),
    /ainda pode estar em andamento/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    run(args, environment(), {
      fetchImpl: async () => {
        calls += 1;
        const incompatible = receipt(operation);
        incompatible.revision.markdown = '# Outro\n';
        return json(incompatible);
      },
    }),
    /não confirmou o payload/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    validateOperation(JSON.parse(await readFile(operationPath, 'utf8'))),
    operation,
  );
});

void test('confirmação 2xx inválida, falha de persistência e falha de stdout preservam estados honestos', async (t) => {
  const invalidDirectory = await temporary(t);
  await writeFile(
    join(invalidDirectory, 'context.json'),
    JSON.stringify(context()),
  );
  await writeFile(join(invalidDirectory, 'proposta.md'), '# Inválida\n');
  await assert.rejects(
    run(publishArguments(invalidDirectory), environment(), {
      fetchImpl: async () => json({}, 201),
      stdout: async () => {},
    }),
    /aceitou a requisição.*confirmação recebida é inválida/,
  );
  const invalidOperation = validateOperation(
    JSON.parse(
      await readFile(join(invalidDirectory, 'operation.json'), 'utf8'),
    ),
  );
  assert.equal(Object.hasOwn(invalidOperation, 'receipt'), false);
  const retryArgs = [
    '--action',
    'retry',
    '--origin',
    origin,
    '--document',
    documentId,
    '--operation',
    join(invalidDirectory, 'operation.json'),
  ];
  for (const status of [401, 503])
    await assert.rejects(
      run(retryArgs, environment(), {
        fetchImpl: async () => json({}, status),
        stdout: async () => {},
      }),
      /POST foi iniciado sem um recibo confiável.*lookup/,
    );

  const persistenceDirectory = await temporary(t);
  await writeFile(
    join(persistenceDirectory, 'context.json'),
    JSON.stringify(context()),
  );
  await writeFile(
    join(persistenceDirectory, 'proposta.md'),
    '# Persistência\n',
  );
  const failingRename = {
    ...operations,
    async rename() {
      throw new Error('synthetic rename failure');
    },
  } as unknown as typeof operations;
  await assert.rejects(
    run(publishArguments(persistenceDirectory), environment(), {
      operations: failingRename,
      fetchImpl: async () => {
        const operation = validateOperation(
          JSON.parse(
            await readFile(
              join(persistenceDirectory, 'operation.json'),
              'utf8',
            ),
          ),
        );
        return json(receipt(operation), 201);
      },
      stdout: async () => {},
    }),
    /revisão foi confirmada.*recibo não foi persistido/,
  );
  const incomplete = validateOperation(
    JSON.parse(
      await readFile(join(persistenceDirectory, 'operation.json'), 'utf8'),
    ),
  );
  assert.equal(Object.hasOwn(incomplete, 'receipt'), false);

  const stdoutDirectory = await temporary(t);
  await writeFile(
    join(stdoutDirectory, 'context.json'),
    JSON.stringify(context()),
  );
  await writeFile(join(stdoutDirectory, 'proposta.md'), '# Saída\n');
  await assert.rejects(
    run(publishArguments(stdoutDirectory), environment(), {
      fetchImpl: async () => {
        const operation = validateOperation(
          JSON.parse(
            await readFile(join(stdoutDirectory, 'operation.json'), 'utf8'),
          ),
        );
        return json(receipt(operation), 201);
      },
      stdout: async () => {
        throw new Error('synthetic stdout failure');
      },
    }),
    /revisão foi confirmada e o recibo foi salvo/,
  );
  const complete = validateOperation(
    JSON.parse(await readFile(join(stdoutDirectory, 'operation.json'), 'utf8')),
  );
  assert.equal(complete.receipt.ordinal, 3);
});

void test(
  'EPIPE real depois do recibo salvo termina com mensagem sanitizada',
  { timeout: 5_000 },
  async (t) => {
    const directory = await temporary(t);
    const server = createServer();
    await new Promise<void>((resolveListen) =>
      server.listen(0, '127.0.0.1', resolveListen),
    );
    t.after(
      () =>
        new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    );
    const address = server.address();
    assert(address && typeof address === 'object');
    const localOrigin = `http://127.0.0.1:${address.port}`;
    const bytes = Buffer.from('# EPIPE\n');
    const operation = createOperation({
      origin: localOrigin,
      documentId,
      context: context(),
      markdown: bytes.toString(),
      bytes,
      file: 'epipe.md',
      title: undefined,
      summary: undefined,
      consideredCommentIds: [],
    });
    const operationPath = join(directory, 'operation.json');
    await writeFile(operationPath, JSON.stringify(operation));
    server.on('request', (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(receipt(operation)));
    });
    const child = spawn(
      process.execPath,
      [
        resolve('scripts/md-colab-revise.mjs'),
        '--action',
        'lookup',
        '--origin',
        localOrigin,
        '--document',
        documentId,
        '--operation',
        operationPath,
      ],
      {
        cwd: resolve('.'),
        env: environment(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.destroy();
    child.stderr.setEncoding('utf8');
    let stderr = '';
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    assert.match(stderr, /revisão foi confirmada e o recibo foi salvo/);
    assert.doesNotMatch(stderr, /EPIPE|Unhandled|node:events/);
    const stored = validateOperation(
      JSON.parse(await readFile(operationPath, 'utf8')),
    );
    assert.equal(stored.receipt.ordinal, 3);
  },
);
