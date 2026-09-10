import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openPersistentD1 } from '../lib/node-d1.ts';

const database = openPersistentD1(
  process.env.MD_COLAB_DB_PATH ?? '/data/md-colab.sqlite',
);
database.sqlite.close();

const serverEntry = resolve(
  process.env.MD_COLAB_SERVER_ENTRY ?? 'dist/standalone/server.js',
);
await import(pathToFileURL(serverEntry).href);
