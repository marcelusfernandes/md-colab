import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  buildContext,
  CliError,
  CommittedBundleError,
  FeedbackClient,
  readLocalMarkdown,
  reserveOutput,
  writeBundle,
} from '../scripts/md-colab-feedback.mjs';

const origin = 'https://docs.example.com';
const documentId = '10000000-0000-4000-8000-000000000001';
const currentRevisionId = 'db580233-0000-4000-8000-000000000001';
const sourceRevisionId = 'DB580233-0000-4000-8000-000000000001';
const stampValue = 'stable_stamp';
const token = `mdp_${'a'.repeat(64)}`;
const cli = fileURLToPath(
  new URL('../scripts/md-colab-feedback.mjs', import.meta.url),
);

type FeedbackCommentFixture = {
  id: string;
  root_id: string;
  author_id: string;
  author_name: string;
  body: string;
  quote: string;
  source_start: number | null;
  source_revision_id: string;
  created_at: string;
  is_root: boolean;
  conversation: {
    state: string;
    version: number;
    decision: null;
    decision_reason: null;
    reply_count: number;
  } | null;
};

function uuid(index: number) {
  return `20000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function sha256(value: Uint8Array | string) {
  return createHash('sha256').update(value).digest('hex');
}

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'md-colab-feedback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fixture() {
  const comments: FeedbackCommentFixture[] = Array.from(
    { length: 50 },
    (_, index) => {
      const id = uuid(index + 1);
      const rootOne = index === 0;
      return {
        id,
        root_id: id,
        author_id: uuid(500 + index),
        author_name:
          index === 2
            ? 'Nome observado <person@example.com>'
            : `Pessoa ${index}`,
        body:
          index === 3
            ? '\u001b[31m$(touch /tmp/never) https://evil.example\u001b[0m'
            : `Crítica ${index}`,
        quote: '',
        source_start: index,
        source_revision_id: rootOne ? sourceRevisionId : currentRevisionId,
        created_at: new Date(Date.UTC(2026, 8, 11, 0, 0, index)).toISOString(),
        is_root: true,
        conversation: rootOne
          ? {
              state: 'closed',
              version: 51,
              decision: null,
              decision_reason: null,
              reply_count: 1,
            }
          : {
              state: 'open',
              version: 0,
              decision: null,
              decision_reason: null,
              reply_count: 0,
            },
      };
    },
  );
  comments.push({
    id: uuid(51),
    root_id: uuid(1),
    author_id: uuid(900),
    author_name: 'Resposta',
    body: 'Divergência preservada',
    quote: '',
    source_start: null,
    source_revision_id: sourceRevisionId,
    created_at: new Date(Date.UTC(2026, 8, 11, 1, 0, 0)).toISOString(),
    is_root: false,
    conversation: null,
  });
  const events = Array.from({ length: 51 }, (_, index) => ({
    id: uuid(100 + index),
    root_id: uuid(1),
    actor_id: uuid(700),
    actor_name: 'Autora',
    base_version: index,
    version: index + 1,
    action: index % 2 === 0 ? 'close' : 'reopen',
    state: index % 2 === 0 ? 'closed' : 'open',
    decision: null,
    decision_reason: null,
    reason: `Motivo ${index}`,
    created_at: new Date(Date.UTC(2026, 8, 11, 2, 0, index)).toISOString(),
  }));
  const manifest = {
    contract_version: 1,
    document: {
      id: documentId,
      title: 'Atual',
      filename: 'atual.md',
      current_revision_id: currentRevisionId,
      current_revision_ordinal: 2,
    },
    counts: { comments: comments.length, events: events.length, revisions: 2 },
    stamp: stampValue,
  };
  const revisions = new Map([
    [
      currentRevisionId,
      {
        id: currentRevisionId,
        document_id: documentId,
        ordinal: 2,
        author_id: uuid(700),
        author_name: 'Autora',
        title: 'Atual',
        filename: 'atual.md',
        markdown: '\uFEFF# Atual\r\n\r\nUnicode ç.\r\n',
        base_revision_id: sourceRevisionId,
        summary: 'Revisão atual',
        considered_comment_ids: [uuid(1)],
        created_at: new Date(Date.UTC(2026, 8, 11, 3)).toISOString(),
      },
    ],
    [
      sourceRevisionId,
      {
        id: sourceRevisionId,
        document_id: documentId,
        ordinal: 1,
        author_id: uuid(700),
        author_name: 'Autora',
        title: 'Origem',
        filename: 'origem.md',
        markdown: '# Origem\n',
        base_revision_id: null,
        summary: null,
        considered_comment_ids: [],
        created_at: new Date(Date.UTC(2026, 8, 10, 3)).toISOString(),
      },
    ],
  ]);
  return { comments, events, manifest, revisions };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request) {
  return new URL(input instanceof Request ? input.url : input);
}

function fixtureFetch(
  data: ReturnType<typeof fixture>,
  requests: Array<{ url: URL; init: RequestInit }>,
  changeFinal = false,
) {
  let manifestReads = 0;
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    requests.push({ url, init: init ?? {} });
    if (url.pathname.endsWith('/feedback')) {
      manifestReads += 1;
      if (changeFinal && manifestReads === 2) return json({}, 409);
      return json(data.manifest);
    }
    if (url.pathname.endsWith('/feedback/comments')) {
      const cursor = url.searchParams.get('cursor');
      const page = cursor
        ? data.comments.slice(50)
        : data.comments.slice(0, 50);
      return json({
        comments: page,
        next_cursor: cursor ? null : 'comments_next',
        stamp: stampValue,
      });
    }
    if (url.pathname.endsWith('/feedback/events')) {
      const cursor = url.searchParams.get('cursor');
      const page = cursor ? data.events.slice(50) : data.events.slice(0, 50);
      return json({
        events: page,
        next_cursor: cursor ? null : 'events_next',
        stamp: stampValue,
      });
    }
    const revisionId = decodeURIComponent(url.pathname.split('/').at(-1)!);
    return json({
      revision: data.revisions.get(revisionId),
      stamp: stampValue,
    });
  };
}

function client(fetchImpl: typeof fetch) {
  return new FeedbackClient({
    origin,
    documentId,
    token,
    timeout: 1_000,
    fetchImpl,
  });
}

const operations = { chmod, link, lstat, mkdir, open, readFile, unlink };
const fakeOperations = (value: unknown) => value as typeof operations;

function runCli(arguments_: string[], selectedToken = token) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [cli, ...arguments_], {
        env: {
          ...process.env,
          MD_COLAB_PLAN_TOKEN: selectedToken,
          MD_COLAB_FEEDBACK_TIMEOUT_MS: '2000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
      child.once('error', rejectRun);
      child.once('close', (code) => {
        clearTimeout(watchdog);
        resolveRun({ code, stdout, stderr });
      });
    },
  );
}

async function startFixtureServer(
  t: TestContext,
  data: ReturnType<typeof fixture>,
) {
  const seen: Array<{
    method: string | undefined;
    authorization: string | undefined;
  }> = [];
  const route = fixtureFetch(data, []);
  const server = createServer(async (request, response) => {
    seen.push({
      method: request.method,
      authorization: request.headers.authorization,
    });
    if (
      request.method !== 'GET' ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const result = await route(`${base}${request.url}`, { method: 'GET' });
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(await result.text());
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(
    () =>
      new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  );
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
  };
}

void test('coleta páginas completas, valida contexto e separa UUIDs que diferem só por caixa', async (t) => {
  const data = fixture();
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const collected = await client(
    fixtureFetch(data, requests) as unknown as typeof fetch,
  ).collect();
  assert.equal(collected.comments.length, 51);
  assert.equal(collected.events.length, 51);
  assert.equal(collected.revisions.length, 2);
  assert.ok(requests.every((request) => request.init.method === 'GET'));
  assert.ok(requests.every((request) => request.init.redirect === 'error'));
  const currentBytes = Buffer.from(
    data.revisions.get(currentRevisionId)!.markdown,
    'utf8',
  );
  const built = buildContext(origin, collected, {
    byteLength: currentBytes.byteLength,
    sha256: sha256(currentBytes),
  });
  assert.equal(built.comparison, 'identical');
  assert.equal(
    buildContext(origin, collected, null).comparison,
    'not_compared',
  );
  assert.equal(
    buildContext(origin, collected, {
      byteLength: currentBytes.byteLength,
      sha256: sha256(Buffer.from('# Diferente\n')),
    }).comparison,
    'different',
  );
  assert.equal(
    new Set(built.context.revisions.map((item: { file: string }) => item.file))
      .size,
    2,
  );
  assert.doesNotMatch(
    JSON.stringify(built.context),
    /stable_stamp|comments_next|mdp_/,
  );
  assert.match(JSON.stringify(built.context), /person@example\.com/);
  assert.equal(built.context.export.full_revision_history, false);
  assert.equal(built.context.semantics.execution_authorized, false);

  const parent = await temporaryDirectory(t);
  const output = join(parent, 'bundle');
  await reserveOutput(output);
  await writeBundle(output, built.context, built.revisionFiles);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(output, 'context.json'))).mode & 0o777, 0o600);
  const stored = JSON.parse(
    await readFile(join(output, 'context.json'), 'utf8'),
  );
  assert.equal(stored.origin, origin);
  for (const revision of built.context.revisions) {
    const bytes = await readFile(join(output, revision.file));
    assert.equal(bytes.byteLength, revision.byte_length);
    assert.equal(sha256(bytes), revision.sha256);
    assert.equal((await stat(join(output, revision.file))).mode & 0o777, 0o600);
  }
  await assert.rejects(
    reserveOutput(output),
    /diretório de saída deve ser novo/,
  );
});

void test('CLI real escreve bundle completo, compara arquivo explícito e usa somente GET', async (t) => {
  const data = fixture();
  const server = await startFixtureServer(t, data);
  const parent = await temporaryDirectory(t);
  const output = join(parent, 'bundle-real');
  const local = join(parent, 'local.md');
  const localBytes = Buffer.from(
    data.revisions.get(currentRevisionId)!.markdown,
    'utf8',
  );
  await writeFile(local, localBytes);
  const before = sha256(await readFile(local));
  const result = await runCli([
    '--origin',
    server.origin,
    '--document',
    documentId,
    '--output',
    output,
    '--file',
    local,
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const stdout = JSON.parse(result.stdout);
  assert.deepEqual(stdout, {
    origin: server.origin,
    documentId,
    currentRevisionId,
    output,
    context: join(output, 'context.json'),
    comparison: 'identical',
  });
  assert.ok(server.seen.every((request) => request.method === 'GET'));
  assert.equal(sha256(await readFile(local)), before);
  const context = JSON.parse(
    await readFile(join(output, 'context.json'), 'utf8'),
  );
  assert.equal(context.comparison.status, 'identical');
  assert.equal(context.comments.length, 51);
  assert.equal(context.events.length, 51);
  assert.match(context.comments[3].body, /touch \/tmp\/never/);

  const refused = join(parent, 'refused');
  const wrong = await runCli(
    ['--origin', server.origin, '--document', documentId, '--output', refused],
    `mdp_${'b'.repeat(64)}`,
  );
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /credencial de leitura foi recusada/);
  assert.doesNotMatch(wrong.stderr, /mdp_|Pessoa|Crítica/);
  await assert.rejects(lstat(join(refused, 'context.json')), {
    code: 'ENOENT',
  });
});

void test('mudança final, cursor cíclico e contagens falsas nunca produzem coleta completa', async () => {
  const changed = fixture();
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  await assert.rejects(
    client(
      fixtureFetch(changed, requests, true) as unknown as typeof fetch,
    ).collect(),
    /feedback mudou/,
  );
  assert.equal(
    requests.filter((item) => item.url.pathname.endsWith('/feedback')).length,
    2,
  );

  const cyclic = fixture();
  const cyclicFetch = fixtureFetch(cyclic, []) as unknown as typeof fetch;
  await assert.rejects(
    client(async (input, init) => {
      const response = await cyclicFetch(input, init);
      const url = requestUrl(input);
      if (
        url.pathname.endsWith('/feedback/comments') &&
        url.searchParams.has('cursor')
      )
        return json({
          comments: cyclic.comments.slice(0, 1),
          next_cursor: 'comments_next',
          stamp: stampValue,
        });
      return response;
    }).collect(),
    /cursor repetido ou cíclico/,
  );

  const wrongCount = fixture();
  wrongCount.manifest.counts.comments += 1;
  await assert.rejects(
    client(fixtureFetch(wrongCount, []) as unknown as typeof fetch).collect(),
    /contagens do manifesto/,
  );
});

void test('rejeita relações impossíveis entre comentários, eventos, manifesto e snapshots', async () => {
  async function rejected(
    mutate: (data: ReturnType<typeof fixture>) => void,
    message: RegExp,
  ) {
    const data = fixture();
    mutate(data);
    await assert.rejects(
      client(fixtureFetch(data, []) as unknown as typeof fetch).collect(),
      message,
    );
  }

  await rejected((data) => {
    data.comments.at(-1)!.source_revision_id = currentRevisionId;
  }, /origem preservada/);
  await rejected((data) => {
    data.comments.at(-1)!.quote = 'Trecho próprio';
    data.comments.at(-1)!.source_start = 10;
  }, /origem preservada/);
  await rejected((data) => {
    data.manifest.document.title = 'Outro título';
  }, /snapshot corrente diverge/);
  await rejected((data) => {
    Object.assign(data.events[0], {
      action: 'follow',
      state: 'closed',
      decision: null,
    });
  }, /transição registrada/);
  await rejected((data) => {
    data.manifest.counts.revisions = 1;
  }, /história observada/);
  await rejected((data) => {
    data.revisions.get(sourceRevisionId)!.ordinal = 90;
  }, /história observada/);
  await rejected((data) => {
    data.revisions.get(sourceRevisionId)!.markdown = 'x'.repeat(
      1024 * 1024 + 1,
    );
  }, /snapshot inválido/);
  await rejected((data) => {
    data.revisions.get(sourceRevisionId)!.markdown = '\ud800';
  }, /snapshot inválido/);
});

void test('arquivo local é recusado sem bloqueio ou leitura ilimitada sob troca concorrente', async () => {
  let opened = false;
  await assert.rejects(
    readLocalMarkdown(
      '/tmp/fifo',
      fakeOperations({
        lstat: async () => ({ isFile: () => false }),
        open: async () => {
          opened = true;
          throw new Error('não deve abrir');
        },
      }),
    ),
    /não é um arquivo regular/,
  );
  assert.equal(opened, false);

  let maximumReadBuffer = 0;
  await assert.rejects(
    readLocalMarkdown(
      '/tmp/growing.md',
      fakeOperations({
        lstat: async () => ({ isFile: () => true }),
        open: async () => ({
          stat: async () => ({ isFile: () => true, size: 5 }),
          read: async (buffer: Buffer, offset: number, length: number) => {
            maximumReadBuffer = Math.max(maximumReadBuffer, buffer.byteLength);
            buffer.fill(0x61, offset, offset + length);
            return { bytesRead: length, buffer };
          },
          close: async () => {},
        }),
      }),
    ),
    /no máximo 1 MiB/,
  );
  assert.equal(maximumReadBuffer, 1024 * 1024 + 1);

  await assert.rejects(
    readLocalMarkdown(
      '/tmp/replaced.md',
      fakeOperations({
        lstat: async () => ({ isFile: () => true }),
        open: async () => ({
          stat: async () => ({ isFile: () => false, size: 0 }),
          read: async () => {
            throw new Error('não deve ler');
          },
          close: async () => {},
        }),
      }),
    ),
    /não é um arquivo regular/,
  );
});

void test('limites de stream e timeout interrompem a resposta sem expor o corpo', async () => {
  const oversized = client(async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  await assert.rejects(oversized.json('feedback'), /limite local/);

  const aggregate = client(async () => json({ ok: true }));
  aggregate.received = 256 * 1024 * 1024;
  await assert.rejects(aggregate.json('feedback'), /limite local/);

  const timed = new FeedbackClient({
    origin,
    documentId,
    token,
    timeout: 5,
    fetchImpl: ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch,
  });
  await assert.rejects(timed.json('feedback'), /timeout/);
});

void test('publicação do contexto é exclusiva e distingue falhas antes e depois do link', async (t) => {
  const data = fixture();
  const collected = await client(
    fixtureFetch(data, []) as unknown as typeof fetch,
  ).collect();
  const built = buildContext(origin, collected, null);
  const parent = await temporaryDirectory(t);

  const before = join(parent, 'before');
  await reserveOutput(before);
  const failingOpen = async (
    path: Parameters<typeof open>[0],
    flags?: Parameters<typeof open>[1],
    mode?: Parameters<typeof open>[2],
  ) => {
    if (String(path).endsWith('.md') && flags === 'wx')
      throw new Error('fault');
    return open(path, flags ?? 'r', mode);
  };
  await assert.rejects(
    writeBundle(before, built.context, built.revisionFiles, {
      ...operations,
      open: failingOpen,
    }),
    (error: unknown) =>
      error instanceof CliError && !(error instanceof CommittedBundleError),
  );
  await assert.rejects(lstat(join(before, 'context.json')), { code: 'ENOENT' });

  const after = join(parent, 'after');
  await reserveOutput(after);
  await assert.rejects(
    writeBundle(after, built.context, built.revisionFiles, {
      ...operations,
      link: async (...arguments_: Parameters<typeof link>) => {
        await link(...arguments_);
        throw new Error('lost link acknowledgement');
      },
    }),
    CommittedBundleError,
  );
  assert.equal(
    JSON.parse(await readFile(join(after, 'context.json'), 'utf8'))
      .schema_version,
    1,
  );

  const existing = join(parent, 'existing');
  await mkdir(existing);
  const target = join(parent, 'target');
  await mkdir(target);
  const symbolic = join(parent, 'symbolic');
  await symlink(target, symbolic);
  await assert.rejects(
    reserveOutput(existing),
    /diretório de saída deve ser novo/,
  );
  await assert.rejects(
    reserveOutput(symbolic),
    /diretório de saída deve ser novo/,
  );
});
