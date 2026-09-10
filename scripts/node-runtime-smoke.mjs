import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'md-colab-standalone-'));
const database = join(directory, 'md-colab.sqlite');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function migrate() {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      'scripts/node-db.ts',
      'migrate',
      '--database',
      database,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(`Migration failed: ${result.stderr}`);
}

function start(port) {
  const child = spawn(process.execPath, ['dist/standalone/server.js'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      MD_COLAB_DB_PATH: database,
      ACCESS_MODE: 'test',
      APP_ORIGIN: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-20000);
    });
  return { child, output: () => output };
}

async function waitUntilReady(origin, processInfo) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null)
      throw new Error(`Standalone exited early:\n${processInfo.output()}`);
    try {
      const response = await fetch(origin + '/api/ready');
      if (response.status === 200) return;
    } catch {
      // Process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Standalone did not become ready:\n${processInfo.output()}`);
}

async function stop(processInfo) {
  if (processInfo.child.exitCode !== null) return;
  processInfo.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => processInfo.child.once('exit', resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Standalone did not stop.')), 5000),
    ),
  ]);
}

function chunkedJson(value) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= encoded.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 257, encoded.length);
      controller.enqueue(encoded.slice(offset, end));
      offset = end;
    },
  });
}

let running;
try {
  migrate();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  running = start(port);
  await waitUntilReady(origin, running);

  const health = await fetch(origin + '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const oversized = await fetch(origin + '/api/auth/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: chunkedJson({ email: 'a'.repeat(5000) }),
    duplex: 'half',
  });
  assert.equal(oversized.status, 413);

  const login = await fetch(origin + '/api/auth/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify({ email: 'smoke@example.test' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  const session = await fetch(origin + '/api/session', {
    headers: { Cookie: cookie },
  });
  assert.equal(session.status, 200);
  const { viewer } = await session.json();
  assert.equal(typeof viewer.id, 'string');

  const documentId = crypto.randomUUID();
  const created = await fetch(origin + '/api/documents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: origin,
    },
    body: JSON.stringify({
      id: documentId,
      authorId: viewer.id,
      filename: 'restart.md',
      markdown: '# Survives restart',
    }),
  });
  assert.equal(created.status, 201);

  await stop(running);
  running = start(port);
  await waitUntilReady(origin, running);

  const listed = await fetch(origin + '/api/documents', {
    headers: { Cookie: cookie },
  });
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.documents.some((document) => document.id === documentId), true);

  console.log(
    JSON.stringify({
      health: 'ok',
      readiness: 'ready',
      chunkedOversizeStatus: oversized.status,
      persistedAcrossRestart: true,
    }),
  );
} finally {
  if (running) await stop(running).catch(() => {});
  rmSync(directory, { recursive: true, force: true });
}
