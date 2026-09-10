import { cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['node_modules/vinext/dist/cli.js', 'build'],
  {
    stdio: 'inherit',
    env: { ...process.env, MD_COLAB_RUNTIME: 'node' },
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

cpSync('drizzle', 'dist/standalone/drizzle', { recursive: true });
