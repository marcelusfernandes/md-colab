import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const originalLstat = fs.lstat;
const target = process.env.MD_TEST_OPERATION_PATH;
const ready = process.env.MD_TEST_OPERATION_READY;
const release = process.env.MD_TEST_OPERATION_RELEASE;
if (!target || !ready || !release)
  throw new Error('Missing test coordination.');

let intercepted = false;
fs.lstat = async function (path, ...options) {
  try {
    return await originalLstat(path, ...options);
  } catch (error) {
    if (!intercepted && String(path) === target && error?.code === 'ENOENT') {
      intercepted = true;
      await fs.writeFile(ready, 'initial lstat returned ENOENT\n', {
        flag: 'wx',
      });
      const deadline = Date.now() + 5_000;
      for (;;) {
        try {
          await fs.access(release);
          break;
        } catch (missing) {
          if (missing?.code !== 'ENOENT') throw missing;
        }
        if (Date.now() > deadline)
          throw new Error('Test interleaving timed out.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw error;
  }
};
syncBuiltinESMExports();
