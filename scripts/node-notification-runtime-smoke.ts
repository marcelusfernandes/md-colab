import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DocumentService } from '../lib/document-service.ts';
import { openPersistentD1 } from '../lib/node-d1.ts';

const directory = mkdtempSync(join(tmpdir(), 'md-colab-notification-'));
const databasePath = join(directory, 'md-colab.sqlite');
const preloadPath = join(directory, 'redirect-resend.mjs');

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
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
      databasePath,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(`Migration failed: ${result.stderr}`);
}

async function seed() {
  const opened = openPersistentD1(databasePath);
  try {
    const owner = new DocumentService(opened.db, {
      id: crypto.randomUUID(),
      name: 'Private owner',
      email: 'owner@qa.invalid',
    });
    const guest = new DocumentService(opened.db, {
      id: crypto.randomUUID(),
      name: 'Private guest',
      email: 'guest@qa.invalid',
    });
    await owner.registerViewer();
    await guest.registerViewer();
    const document = await owner.create({
      id: crypto.randomUUID(),
      authorId: owner.viewer.id,
      title: 'Secret title',
      filename: 'secret.md',
      markdown: '# Secret contents',
    });
    await owner.share(document.id, {
      email: guest.viewer.email,
      name: guest.viewer.name,
    });
    const created = await guest.addComment(document.id, {
      id: crypto.randomUUID(),
      authorId: guest.viewer.id,
      body: 'Secret review body',
    });
    return { documentId: document.id, commentId: created.id };
  } finally {
    opened.sqlite.close();
  }
}

type DeliveryRow = {
  status: string;
  attempts: number;
  uncertain: number;
  provider_id: string | null;
};

function delivery() {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return sqlite
      .prepare(
        `SELECT status,attempts,uncertain,provider_id
         FROM notification_deliveries`,
      )
      .get() as DeliveryRow;
  } finally {
    sqlite.close();
  }
}

function start(port: number, providerUrl: string) {
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', 'scripts/start-node.ts'],
    {
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        MD_COLAB_DB_PATH: databasePath,
        ACCESS_MODE: 'email',
        APP_ORIGIN: `http://127.0.0.1:${port}`,
        RESEND_API_KEY: 're_synthetic',
        MAIL_FROM: 'Notices <notices@qa.invalid>',
        NOTIFICATION_DRAIN_INTERVAL_MS: '100',
        NOTIFICATION_RETRY_BASE_SECONDS: '1',
        FAKE_RESEND_URL: providerUrl,
        NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-20_000);
    });
  return { child, output: () => output };
}

async function waitFor(
  processInfo: { child: ChildProcess; output: () => string },
  condition: () => boolean | Promise<boolean>,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null)
      throw new Error(`Standalone exited early:\n${processInfo.output()}`);
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Notification smoke timed out:\n${processInfo.output()}`);
}

async function stop(processInfo: {
  child: ChildProcess;
  output: () => string;
}) {
  if (processInfo.child.exitCode !== null) return;
  processInfo.child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => processInfo.child.once('exit', resolve)),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`Standalone did not stop:\n${processInfo.output()}`),
          ),
        5_000,
      ),
    ),
  ]);
}

writeFileSync(
  preloadPath,
  `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return originalFetch(url === 'https://api.resend.com/emails' ? process.env.FAKE_RESEND_URL : input, init);
};
`,
  { mode: 0o600 },
);

const requests: Array<{ body: string; idempotencyKey: string | undefined }> =
  [];
let disconnectFirst = true;
const provider = createHttpServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/emails');
    requests.push({
      body: Buffer.concat(chunks).toString('utf8'),
      idempotencyKey: request.headers['idempotency-key'] as string | undefined,
    });
    if (disconnectFirst) {
      disconnectFirst = false;
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'provider-after-restart' }));
  });
});

let running: ReturnType<typeof start> | undefined;
try {
  migrate();
  const created = await seed();
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  const providerUrl = `http://127.0.0.1:${address.port}/emails`;
  const port = await freePort();

  running = start(port, providerUrl);
  await waitFor(
    running,
    () => requests.length === 1 && delivery().status === 'pending',
  );
  assert.equal(delivery().uncertain, 1);
  assert.equal(delivery().attempts, 1);
  await stop(running);

  running = start(port, providerUrl);
  await waitFor(running, () => delivery().status === 'sent');
  assert.equal(delivery().provider_id, 'provider-after-restart');
  await stop(running);

  assert.equal(requests.length, 2);
  assert.ok(requests[0]?.idempotencyKey);
  assert.equal(requests[1]?.idempotencyKey, requests[0]?.idempotencyKey);
  assert.equal(requests[1]?.body, requests[0]?.body);
  assert.equal(requests[0]?.body.includes('Secret title'), false);
  assert.equal(requests[0]?.body.includes('Secret review body'), false);
  assert.equal(
    requests[0]?.body.includes(
      `/d/${created.documentId}?comment=${created.commentId}`,
    ),
    true,
  );
  console.log(
    JSON.stringify({
      automaticDrain: true,
      uncertainRestartRecovered: true,
      stableIdempotencyKey: true,
      stablePayload: true,
      gracefulSigterm: true,
      providerRequests: requests.length,
    }),
  );
} finally {
  if (running) await stop(running).catch(() => {});
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
}
