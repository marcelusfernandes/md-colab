import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openPersistentD1 } from '../lib/node-d1.ts';

function options(values: string[]) {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--'))
      throw new Error('Every option must be a --name value pair.');
    if (result.has(key)) throw new Error(`Duplicate option: ${key}.`);
    result.set(key, value);
  }
  for (const key of result.keys())
    if (!['--database', '--output'].includes(key))
      throw new Error(`Unknown option: ${key}.`);
  return result;
}

function required(values: Map<string, string>, key: string) {
  const value = values.get(key);
  if (!value) throw new Error(`Missing required option ${key}.`);
  return value;
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

const values = options(process.argv.slice(2));
const database = required(values, '--database');
const output = resolve(required(values, '--output'));
if (existsSync(output)) throw new Error(`Output already exists at ${output}.`);

const opened = openPersistentD1(database);
try {
  const existing = opened.sqlite
    .prepare(
      `SELECT
        (SELECT count(*) FROM users) AS users,
        (SELECT count(*) FROM documents) AS documents`,
    )
    .get() as { users: number; documents: number };
  if (existing.users !== 0 || existing.documents !== 0)
    throw new Error('QA fixture requires a migrated database without application data.');

  const documentId = randomUUID();
  const documentCreatedAt = new Date().toISOString();
  const documentTitle = 'QA authorization plan';
  const documentFilename = 'qa-plan.md';
  const documentMarkdown =
    '# QA authorization plan\n\nSynthetic content for browser validation.';
  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const identities = [
    { role: 'owner', id: randomUUID(), email: 'owner@qa.invalid' },
    { role: 'guest', id: randomUUID(), email: 'guest@qa.invalid' },
    { role: 'stranger', id: randomUUID(), email: 'stranger@qa.invalid' },
  ].map((identity) => ({ ...identity, token: randomBytes(32).toString('hex') }));

  opened.sqlite.exec('BEGIN IMMEDIATE');
  try {
    const insertUser = opened.sqlite.prepare(
      'INSERT INTO users(id,email,name) VALUES(?,?,?)',
    );
    const insertSession = opened.sqlite.prepare(
      'INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',
    );
    for (const identity of identities) {
      insertUser.run(identity.id, identity.email, identity.role);
      insertSession.run(hash(identity.token), identity.id, expiresAt);
    }
    opened.sqlite
      .prepare(
        `INSERT INTO documents(
          id,owner_id,title,filename,markdown,created_at,is_test,current_revision_id
        ) VALUES(?,?,?,?,?,?,0,NULL)`,
      )
      .run(
        documentId,
        identities[0].id,
        documentTitle,
        documentFilename,
        documentMarkdown,
        documentCreatedAt,
      );
    opened.sqlite
      .prepare(
        `INSERT INTO document_revisions(
          id,document_id,ordinal,author_id,title,filename,markdown,created_at
        ) VALUES(?,?,1,?,?,?,?,?)`,
      )
      .run(
        documentId,
        documentId,
        identities[0].id,
        documentTitle,
        documentFilename,
        documentMarkdown,
        documentCreatedAt,
      );
    opened.sqlite
      .prepare(
        `UPDATE documents SET current_revision_id=?
         WHERE id=? AND current_revision_id IS NULL`,
      )
      .run(documentId, documentId);
    opened.sqlite
      .prepare(
        'INSERT INTO shares(document_id,email,name,created_at) VALUES(?,?,?,?)',
      )
      .run(
        documentId,
        identities[1].email,
        'guest',
        new Date().toISOString(),
      );
    opened.sqlite.exec('COMMIT');
  } catch (error) {
    opened.sqlite.exec('ROLLBACK');
    throw error;
  }

  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(
    output,
    JSON.stringify(
      {
        synthetic: true,
        documentId,
        expiresAt,
        identities: Object.fromEntries(
          identities.map((identity) => [
            identity.role,
            {
              email: identity.email,
              cookie: `md_session=${identity.token}`,
            },
          ]),
        ),
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  chmodSync(output, 0o600);
  console.log(JSON.stringify({ database: opened.path, output, documentId }));
} finally {
  opened.sqlite.close();
}
