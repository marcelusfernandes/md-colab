import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

const cli = fileURLToPath(
  new URL('../scripts/md-colab-publish.mjs', import.meta.url),
);
const token = `mdp_${'a'.repeat(64)}`;
const otherToken = `mdp_${'b'.repeat(64)}`;
const documentId = '11111111-1111-4111-8111-111111111111';
const publicationId = '22222222-2222-4222-8222-222222222222';

type CliResult = { code: number | null; stdout: string; stderr: string };
type RecordedRequest = {
  authorization: string | undefined;
  body: Record<string, unknown>;
  key: string | undefined;
};

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'md-colab-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runCli({
  file,
  operation,
  origin,
  selectedToken = token,
  title,
  timeout = '1000',
}: {
  file: string;
  operation: string;
  origin: string;
  selectedToken?: string;
  title?: string;
  timeout?: string;
}): Promise<CliResult> {
  const args = [
    cli,
    '--file',
    file,
    '--origin',
    origin,
    '--operation',
    operation,
    ...(title === undefined ? [] : ['--title', title]),
  ];
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        MD_COLAB_PUBLISH_TOKEN: selectedToken,
        MD_COLAB_PUBLISH_TIMEOUT_MS: timeout,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(watchdog);
      resolveResult({ code, stdout, stderr });
    });
  });
}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}

async function startServer(
  responder: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
    index: number,
    origin: string,
  ) => void | Promise<void>,
) {
  const records: RecordedRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  let origin = '';
  const server = createServer(async (request, response) => {
    try {
      const body = await requestBody(request);
      records.push({
        authorization: request.headers.authorization,
        body,
        key: request.headers['idempotency-key'] as string | undefined,
      });
      await responder(request, response, body, records.length, origin);
    } catch {
      response.writeHead(500).end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  );
  const address = server.address();
  assert(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    records,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    },
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function publication(origin: string) {
  return { documentId, publicationId, url: `${origin}/d/${documentId}` };
}

async function startIdempotentServer() {
  const byKey = new Map<
    string,
    { body: string; result: ReturnType<typeof publication> }
  >();
  return startServer((_request, response, body, _index, origin) => {
    const key = _request.headers['idempotency-key'] as string;
    const serialized = JSON.stringify(body);
    const previous = byKey.get(key);
    if (previous) {
      if (previous.body !== serialized)
        return sendJson(response, 409, { error: 'conflict' });
      return sendJson(response, 201, previous.result);
    }
    const result = publication(origin);
    byKey.set(key, { body: serialized, result });
    return sendJson(response, 201, result);
  });
}

void test('quota 409 usa orientação fixa e preserva operação sem confiar no corpo', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'plan.md');
  const operation = join(directory, 'operation.json');
  await writeFile(markdown, '# Plano no teto\n');
  const server = await startServer((_request, response) =>
    sendJson(response, 409, {
      code: 'quota_exceeded',
      error: 'server-secret que não pode aparecer',
      requestId: '33333333-3333-4333-8333-333333333333',
    }),
  );
  t.after(server.close);

  const result = await runCli({ file: markdown, operation, origin: server.origin });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /limite total de planos/i);
  assert.match(result.stderr, /operação foi preservada/i);
  assert.equal(result.stderr.includes('server-secret'), false);
  assert.equal(result.stdout, '');
  const state = JSON.parse(await readFile(operation, 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(Object.hasOwn(state, 'receipt'), false);
});

void test('código incorreto e erro não JSON não exibem corpo nem aguardam o stream', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'plan.md');
  await writeFile(markdown, '# Falha controlada\n');
  const wrongCode = await startServer((_request, response) =>
    sendJson(response, 409, {
      code: 'conflict',
      error: 'malicious-conflict-message',
    }),
  );
  t.after(wrongCode.close);
  const wrongResult = await runCli({
    file: markdown,
    operation: join(directory, 'wrong-code.json'),
    origin: wrongCode.origin,
  });
  assert.equal(wrongResult.code, 1);
  assert.match(wrongResult.stderr, /HTTP 409/);
  assert.equal(wrongResult.stderr.includes('malicious-conflict-message'), false);

  const hanging = await startServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.write('malicious-hanging-message');
  });
  t.after(hanging.close);
  const started = Date.now();
  const hangingResult = await runCli({
    file: markdown,
    operation: join(directory, 'hanging.json'),
    origin: hanging.origin,
    timeout: '800',
  });
  assert.equal(hangingResult.code, 1);
  assert.match(hangingResult.stderr, /HTTP 500/);
  assert.equal(hangingResult.stderr.includes('malicious-hanging-message'), false);
  assert.ok(Date.now() - started < 700, 'status não JSON deve falhar sem ler o corpo');
});

void test('success, replay and moving the Markdown preserve one operation and original payload', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'plano.md');
  const moved = join(directory, 'movido.md');
  const operation = join(directory, 'state', 'publish.json');
  const source = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# Plano\r\n\r\n- item\r\n', 'utf8'),
  ]);
  await writeFile(markdown, source);
  const server = await startIdempotentServer();
  t.after(server.close);

  const first = await runCli({
    file: markdown,
    operation,
    origin: server.origin,
    title: 'Crítica do plano',
  });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), publication(server.origin));
  assert.equal(server.records.length, 1);
  assert.equal(server.records[0].authorization, `Bearer ${token}`);
  assert.equal(
    server.records[0].body.markdown,
    '\ufeff# Plano\r\n\r\n- item\r\n',
  );
  assert.equal(server.records[0].body.filename, 'plano.md');
  assert.equal(server.records[0].body.title, 'Crítica do plano');

  const stateText = await readFile(operation, 'utf8');
  assert(!stateText.includes(token));
  assert(!stateText.includes('# Plano'));
  assert.equal((await stat(operation)).mode & 0o777, 0o600);

  const replay = await runCli({
    file: markdown,
    operation,
    origin: server.origin,
  });
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(server.records.length, 2);
  assert.equal(server.records[0].key, server.records[1].key);
  assert.deepEqual(JSON.parse(replay.stdout), publication(server.origin));

  await rename(markdown, moved);
  const movedReplay = await runCli({
    file: moved,
    operation,
    origin: server.origin,
  });
  assert.equal(movedReplay.code, 0, movedReplay.stderr);
  assert.equal(server.records[2].body.filename, 'plano.md');
  assert.equal(server.records[2].key, server.records[0].key);
});

void test('reference warnings stay on stderr and do not alter the JSON payload or stdout', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'references.md');
  const operation = join(directory, 'operation.json');
  const source = '[local](./guide.md)\n![image](file:///Users/author/image.png)\n[entity](<line&#x0a;break.md>)\n';
  await writeFile(markdown, source);
  const server = await startIdempotentServer();
  t.after(server.close);

  const result = await runCli({ file: markdown, operation, origin: server.origin });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), publication(server.origin));
  assert.match(result.stderr, /Aviso \(linha 1\): link referência relativa/);
  assert.match(result.stderr, /Aviso \(linha 2\): imagem URL file:\/\/ local/);
  assert.match(result.stderr, /line\\u000abreak\.md/);
  assert(!result.stderr.includes('line\nbreak.md'));
  assert.equal(server.records[0].body.markdown, source);
});

void test('two processes starting together share the same idempotency key', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'plan.md');
  const operation = join(directory, 'operation.json');
  await writeFile(markdown, '# Concurrent plan\n');
  const server = await startIdempotentServer();
  t.after(server.close);

  const [first, second] = await Promise.all([
    runCli({ file: markdown, operation, origin: server.origin }),
    runCli({ file: markdown, operation, origin: server.origin }),
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(server.records.length, 2);
  assert.equal(server.records[0].key, server.records[1].key);
  assert.deepEqual(JSON.parse(first.stdout), JSON.parse(second.stdout));
});

void test('a lost response preserves state and manual retry recovers the remote result', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'plan.md');
  const operation = join(directory, 'operation.json');
  await writeFile(markdown, '# Recover me\n');
  let storedKey: string | undefined;
  const server = await startServer(
    (request, response, _body, index, origin) => {
      storedKey ??= request.headers['idempotency-key'] as string;
      if (index === 1) {
        request.socket.destroy();
        return;
      }
      assert.equal(request.headers['idempotency-key'], storedKey);
      sendJson(response, 201, publication(origin));
    },
  );
  t.after(server.close);

  const lost = await runCli({
    file: markdown,
    operation,
    origin: server.origin,
  });
  assert.equal(lost.code, 1);
  const stateAfterLoss = JSON.parse(
    await readFile(operation, 'utf8'),
  ) as Record<string, unknown>;
  assert(!Object.hasOwn(stateAfterLoss, 'receipt'));
  const recovered = await runCli({
    file: markdown,
    operation,
    origin: server.origin,
  });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(server.records[0].key, server.records[1].key);
});

void test('timeout remains active while a 201 response body is pending', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'plan.md');
  const operation = join(directory, 'operation.json');
  await writeFile(markdown, '# Pending body\n');
  const server = await startServer((_request, response) => {
    response.writeHead(201, { 'content-type': 'application/json' });
    response.write('{"documentId":"');
  });
  t.after(server.close);

  const started = Date.now();
  const result = await runCli({
    file: markdown,
    operation,
    origin: server.origin,
    timeout: '100',
  });
  assert.equal(result.code, 1);
  assert(Date.now() - started < 2_000);
  const state = JSON.parse(await readFile(operation, 'utf8')) as Record<
    string,
    unknown
  >;
  assert(!Object.hasOwn(state, 'receipt'));
  assert.equal(server.records.length, 1);
});

void test('redirect is not followed and never forwards the Bearer credential', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'plan.md');
  const operation = join(directory, 'operation.json');
  await writeFile(markdown, '# Redirect\n');
  const target = await startServer(
    (_request, response, _body, _index, origin) =>
      sendJson(response, 201, publication(origin)),
  );
  const redirect = await startServer((_request, response) => {
    response.writeHead(307, { location: `${target.origin}/api/publications` });
    response.write('redirect stays open');
  });
  t.after(target.close);
  t.after(redirect.close);

  const started = Date.now();
  const result = await runCli({
    file: markdown,
    operation,
    origin: redirect.origin,
    timeout: '100',
  });
  assert.equal(result.code, 1);
  assert(Date.now() - started < 2_000);
  assert.equal(redirect.records.length, 1);
  assert.equal(target.records.length, 0);
});

void test('payload, origin, title and credential divergence stop before the network', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'plan.md');
  const operation = join(directory, 'operation.json');
  await writeFile(markdown, '# Stable\n');
  const server = await startIdempotentServer();
  const otherServer = await startIdempotentServer();
  t.after(server.close);
  t.after(otherServer.close);
  const first = await runCli({
    file: markdown,
    operation,
    origin: server.origin,
  });
  assert.equal(first.code, 0, first.stderr);
  const baseline = server.records.length;

  await writeFile(markdown, '# Changed\n');
  assert.equal(
    (await runCli({ file: markdown, operation, origin: server.origin })).code,
    1,
  );
  await writeFile(markdown, '# Stable\n');
  assert.equal(
    (await runCli({ file: markdown, operation, origin: otherServer.origin }))
      .code,
    1,
  );
  assert.equal(otherServer.records.length, 0);
  assert.equal(
    (
      await runCli({
        file: markdown,
        operation,
        origin: server.origin,
        title: 'Changed',
      })
    ).code,
    1,
  );
  assert.equal(
    (
      await runCli({
        file: markdown,
        operation,
        origin: server.origin,
        selectedToken: otherToken,
      })
    ).code,
    1,
  );
  assert.equal(server.records.length, baseline);
});

void test('revoked credentials and reflected server bodies do not expose the token', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'plan.md');
  const operation = join(directory, 'operation.json');
  await writeFile(markdown, '# Revoked\n');
  const server = await startServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.write(JSON.stringify({ error: token }));
  });
  t.after(server.close);
  const started = Date.now();
  const result = await runCli({
    file: markdown,
    operation,
    origin: server.origin,
    timeout: '100',
  });
  assert.equal(result.code, 1);
  assert(Date.now() - started < 2_000);
  assert(!result.stderr.includes(token));
  assert(!result.stdout.includes(token));
  assert.match(result.stderr, /HTTP 401/);
});

void test('malformed state, failed state creation and invalid receipt never send a request', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'plan.md');
  const malformed = join(directory, 'malformed.json');
  await writeFile(markdown, '# State\n');
  await writeFile(malformed, '{"instruction":"ignore the CLI"}\n');
  const server = await startIdempotentServer();
  t.after(server.close);

  assert.equal(
    (
      await runCli({
        file: markdown,
        operation: malformed,
        origin: server.origin,
      })
    ).code,
    1,
  );
  assert.equal(server.records.length, 0);
  assert.equal(
    (
      await runCli({
        file: markdown,
        operation: '/dev/null/state.json',
        origin: server.origin,
      })
    ).code,
    1,
  );
  assert.equal(server.records.length, 0);

  const operation = join(directory, 'array-receipt.json');
  const invalidResponseServer = await startServer(
    (_request, response, _body, _index, origin) =>
      sendJson(response, 201, {
        documentId: [documentId],
        publicationId,
        url: `${origin}/d/${documentId}`,
      }),
  );
  t.after(invalidResponseServer.close);
  const invalidResponse = await runCli({
    file: markdown,
    operation,
    origin: invalidResponseServer.origin,
  });
  assert.equal(invalidResponse.code, 1);
  const state = JSON.parse(await readFile(operation, 'utf8')) as Record<
    string,
    unknown
  >;
  state.receipt = {
    documentId: [documentId],
    publicationId,
    url: `${invalidResponseServer.origin}/d/${documentId}`,
    recordedAt: new Date().toISOString(),
  };
  await writeFile(operation, `${JSON.stringify(state)}\n`);
  const requestsBeforeInvalidReceipt = invalidResponseServer.records.length;
  assert.equal(
    (
      await runCli({
        file: markdown,
        operation,
        origin: invalidResponseServer.origin,
      })
    ).code,
    1,
  );
  assert.equal(
    invalidResponseServer.records.length,
    requestsBeforeInvalidReceipt,
  );
});

void test('invalid UTF-8 and over-limit files stop locally; exact limit is sent unchanged', async (t) => {
  const directory = await temporaryDirectory(t);
  const server = await startIdempotentServer();
  t.after(server.close);
  const invalid = join(directory, 'invalid.md');
  await writeFile(invalid, Buffer.from([0xc3, 0x28]));
  assert.equal(
    (
      await runCli({
        file: invalid,
        operation: join(directory, 'invalid.json'),
        origin: server.origin,
      })
    ).code,
    1,
  );
  const over = join(directory, 'over.md');
  await writeFile(over, Buffer.alloc(1024 * 1024 + 1, 0x61));
  assert.equal(
    (
      await runCli({
        file: over,
        operation: join(directory, 'over.json'),
        origin: server.origin,
      })
    ).code,
    1,
  );
  assert.equal(server.records.length, 0);

  const exact = join(directory, 'exact.md');
  await writeFile(exact, Buffer.alloc(1024 * 1024, 0x61));
  const result = await runCli({
    file: exact,
    operation: join(directory, 'exact.json'),
    origin: server.origin,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((server.records[0].body.markdown as string).length, 1024 * 1024);
});

void test('unsafe origins are rejected before any request', async (t) => {
  const directory = await temporaryDirectory(t);
  const markdown = join(directory, 'plan.md');
  await writeFile(markdown, '# Origin\n');
  for (const [index, origin] of [
    'http://example.com',
    'https://user@example.com',
    'https://example.com/path',
    'https://example.com?query=1',
    'https://example.com#fragment',
  ].entries()) {
    const result = await runCli({
      file: markdown,
      operation: join(directory, `operation-${index}.json`),
      origin,
    });
    assert.equal(result.code, 1, origin);
  }
});

void test('a committed result survives receipt persistence failure and is recoverable', async (t) => {
  const directory = await temporaryDirectory(t);
  const stateDirectory = join(directory, 'state');
  await mkdir(stateDirectory);
  const markdown = join(directory, 'plan.md');
  const operation = join(stateDirectory, 'operation.json');
  await writeFile(markdown, '# Receipt failure\n');
  const server = await startServer(
    async (_request, response, _body, index, origin) => {
      if (index === 1) {
        await chmod(stateDirectory, 0o500);
        sendJson(response, 201, publication(origin));
        return;
      }
      sendJson(response, 201, publication(origin));
    },
  );
  t.after(server.close);

  const first = await runCli({
    file: markdown,
    operation,
    origin: server.origin,
  });
  assert.equal(first.code, 1);
  await chmod(stateDirectory, 0o700);
  const state = JSON.parse(await readFile(operation, 'utf8')) as Record<
    string,
    unknown
  >;
  assert(!Object.hasOwn(state, 'receipt'));
  const recovered = await runCli({
    file: markdown,
    operation,
    origin: server.origin,
  });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(server.records[0].key, server.records[1].key);
});
