import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const originalLstat = fs.lstat;
const originalReadFile = fs.readFile;
const target = process.env.MD_TEST_OPERATION_PATH;
const fault = process.env.MD_TEST_OPERATION_READ_FAULT;
if (!target || !['ENOENT', 'EIO'].includes(fault))
  throw new Error('Invalid test fault configuration.');

let armed = false;
fs.lstat = async function (path, ...options) {
  const result = await originalLstat(path, ...options);
  if (!armed && String(path) === target) {
    armed = true;
    if (fault === 'ENOENT') await fs.unlink(target);
  }
  return result;
};
fs.readFile = async function (path, ...options) {
  if (armed && String(path) === target) {
    armed = false;
    if (fault === 'EIO') {
      const error = new Error('synthetic operation read failure');
      error.code = 'EIO';
      throw error;
    }
  }
  return originalReadFile(path, ...options);
};
syncBuiltinESMExports();
