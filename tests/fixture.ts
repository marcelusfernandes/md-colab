import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import type { AccessEmail, Mailer } from '../lib/mailer.ts';
import { createNodeD1 } from '../lib/node-d1.ts';
import { HttpError } from '../lib/document-service.ts';

export function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const directory = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  const db = createNodeD1(sqlite);
  return { sqlite, db };
}

// In-memory transport only injected by tests. There is no runtime bypass or public mailbox endpoint.
export class TestMailbox implements Mailer {
  messages: AccessEmail[] = [];
  fail = false;
  configured = true;
  assertConfigured() {
    if (!this.configured)
      throw new HttpError(503, 'O envio de e-mails ainda não foi configurado.');
  }
  async send(message: AccessEmail) {
    this.assertConfigured();
    if (this.fail) throw new Error('Provider unavailable');
    this.messages.push(message);
  }
  lastToken() {
    const message = this.messages.at(-1);
    if (!message) throw new Error('No email');
    return new URLSearchParams(new URL(message.url).hash.slice(1)).get(
      'token',
    )!;
  }
}
