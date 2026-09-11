import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openPersistentD1 } from '../lib/node-d1.ts';
import { startNodeNotificationRunner } from '../lib/node-notification-runner.ts';

const database = openPersistentD1(
  process.env.MD_COLAB_DB_PATH ?? '/data/md-colab.sqlite',
);
database.sqlite.close();

const serverEntry = resolve(
  process.env.MD_COLAB_SERVER_ENTRY ?? 'dist/standalone/server.js',
);
await import(pathToFileURL(serverEntry).href);

const notificationDatabase = openPersistentD1(
  process.env.MD_COLAB_DB_PATH ?? '/data/md-colab.sqlite',
);
startNodeNotificationRunner({
  DB: notificationDatabase.db,
  ACCESS_MODE: process.env.ACCESS_MODE,
  APP_ORIGIN: process.env.APP_ORIGIN,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  MAIL_FROM: process.env.MAIL_FROM,
  NOTIFICATION_DRAIN_LIMIT: process.env.NOTIFICATION_DRAIN_LIMIT,
  NOTIFICATION_DRAIN_INTERVAL_MS: process.env.NOTIFICATION_DRAIN_INTERVAL_MS,
  NOTIFICATION_LEASE_SECONDS: process.env.NOTIFICATION_LEASE_SECONDS,
  NOTIFICATION_RETRY_BASE_SECONDS: process.env.NOTIFICATION_RETRY_BASE_SECONDS,
});
