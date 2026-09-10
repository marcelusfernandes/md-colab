#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const STATE_VERSION = 1;
const TOKEN_ENV = 'MD_COLAB_PUBLISH_TOKEN';
const TIMEOUT_ENV = 'MD_COLAB_PUBLISH_TIMEOUT_MS';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class CliError extends Error {}

function usage() {
  return `Uso:
  npm run --silent publish:markdown -- --file <plano.md> --origin <origem> --operation <estado.json> [--title <titulo>]

Variáveis:
  ${TOKEN_ENV}             credencial mdp_... (obrigatória)
  ${TIMEOUT_ENV}         timeout de uma tentativa em ms (opcional; padrão ${DEFAULT_TIMEOUT_MS})`;
}

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const values = new Map();
  const allowed = new Set(['--file', '--origin', '--operation', '--title']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.length === 0)
      throw new CliError(`Argumentos inválidos.\n${usage()}`);
    if (values.has(flag)) throw new CliError(`Argumento repetido: ${flag}.`);
    values.set(flag, value);
  }

  for (const required of ['--file', '--origin', '--operation']) {
    if (!values.has(required))
      throw new CliError(`Falta ${required}.\n${usage()}`);
  }

  return {
    file: resolve(values.get('--file')),
    operation: resolve(values.get('--operation')),
    origin: validateOrigin(values.get('--origin')),
    title: values.get('--title'),
  };
}

function validateOrigin(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new CliError('A origem do serviço é inválida.');
  }

  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new CliError(
      'Use uma origem HTTPS sem credenciais, query, fragmento ou caminho; HTTP é aceito apenas em loopback local.',
    );
  return url.origin;
}

function validateToken(token) {
  if (!/^mdp_[0-9a-f]{64}$/.test(token ?? ''))
    throw new CliError(`Defina uma credencial válida em ${TOKEN_ENV}.`);
  return token;
}

function timeoutFromEnvironment(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^[1-9]\d*$/.test(value))
    throw new CliError(`${TIMEOUT_ENV} deve ser um número inteiro positivo.`);
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout > 300_000)
    throw new CliError(`${TIMEOUT_ENV} deve ficar entre 1 e 300000 ms.`);
  return timeout;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys) {
  const compare = (left, right) => left.localeCompare(right);
  const actual = Object.keys(value).sort(compare);
  const expected = [...keys].sort(compare);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

async function readMarkdown(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new CliError('O Markdown selecionado não é um arquivo regular.');
    if (stat.size > MAX_MARKDOWN_BYTES)
      throw new CliError('O Markdown deve ter no máximo 1 MiB em UTF-8.');
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_MARKDOWN_BYTES)
      throw new CliError('O Markdown deve ter no máximo 1 MiB em UTF-8.');
    let markdown;
    try {
      markdown = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw new CliError('O Markdown selecionado não é UTF-8 válido.');
    }
    if (!markdown.trim())
      throw new CliError('O Markdown não pode ficar vazio.');
    return { bytes, markdown };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Não foi possível ler o Markdown selecionado.');
  } finally {
    await handle?.close();
  }
}

function validateNewMetadata(filename, title) {
  if (!filename.trim() || filename.length > 255)
    throw new CliError('O nome do arquivo deve ter entre 1 e 255 caracteres.');
  if (title !== undefined && (!title.trim() || title.length > 240))
    throw new CliError('O título deve ter entre 1 e 240 caracteres.');
}

function payloadDigest(markdown, filename, title) {
  return sha256(JSON.stringify([markdown, filename, title]));
}

function newOperation({ markdown, bytes, filename, title, origin, token }) {
  const normalizedTitle = title ?? null;
  return {
    version: STATE_VERSION,
    idempotencyKey: `mdcolab_${randomBytes(32).toString('hex')}`,
    origin,
    credentialFingerprint: sha256(token),
    payload: {
      markdownSha256: sha256(bytes),
      payloadSha256: payloadDigest(markdown, filename, normalizedTitle),
      byteLength: bytes.byteLength,
      filename,
      title: normalizedTitle,
    },
    createdAt: new Date().toISOString(),
  };
}

function validateReceipt(receipt, origin) {
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    !exactKeys(receipt, ['documentId', 'publicationId', 'url', 'recordedAt']) ||
    typeof receipt.documentId !== 'string' ||
    typeof receipt.publicationId !== 'string' ||
    !UUID.test(receipt.documentId) ||
    !UUID.test(receipt.publicationId) ||
    typeof receipt.recordedAt !== 'string'
  )
    throw new CliError('O recibo no arquivo de operação é inválido.');
  validatePublicationUrl(receipt.url, receipt.documentId, origin);
  return receipt;
}

function validateOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CliError('O arquivo de operação é inválido.');
  const hasReceipt = Object.hasOwn(value, 'receipt');
  const keys = [
    'version',
    'idempotencyKey',
    'origin',
    'credentialFingerprint',
    'payload',
    'createdAt',
    ...(hasReceipt ? ['receipt'] : []),
  ];
  if (
    !exactKeys(value, keys) ||
    value.version !== STATE_VERSION ||
    typeof value.idempotencyKey !== 'string' ||
    !/^[\x21-\x7e]{1,128}$/.test(value.idempotencyKey) ||
    typeof value.credentialFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.credentialFingerprint) ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !value.payload ||
    typeof value.payload !== 'object' ||
    Array.isArray(value.payload) ||
    !exactKeys(value.payload, [
      'markdownSha256',
      'payloadSha256',
      'byteLength',
      'filename',
      'title',
    ]) ||
    !/^[0-9a-f]{64}$/.test(value.payload.markdownSha256) ||
    !/^[0-9a-f]{64}$/.test(value.payload.payloadSha256) ||
    !Number.isSafeInteger(value.payload.byteLength) ||
    value.payload.byteLength < 1 ||
    value.payload.byteLength > MAX_MARKDOWN_BYTES ||
    typeof value.payload.filename !== 'string' ||
    !value.payload.filename.trim() ||
    value.payload.filename.length > 255 ||
    (value.payload.title !== null &&
      (typeof value.payload.title !== 'string' ||
        !value.payload.title.trim() ||
        value.payload.title.length > 240))
  )
    throw new CliError('O arquivo de operação é inválido.');

  let origin;
  try {
    origin = validateOrigin(value.origin);
  } catch {
    throw new CliError('A origem no arquivo de operação é inválida.');
  }
  if (origin !== value.origin)
    throw new CliError('A origem no arquivo de operação não está normalizada.');
  if (hasReceipt) validateReceipt(value.receipt, origin);
  return value;
}

async function readOperation(operationPath) {
  try {
    const stat = await lstat(operationPath);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES)
      throw new CliError('O arquivo de operação é inválido.');
    const source = await readFile(operationPath, 'utf8');
    return validateOperation(JSON.parse(source));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      'O arquivo de operação é inválido e não foi sobrescrito.',
    );
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryTree(directory) {
  let current = resolve(directory);
  for (;;) {
    await syncDirectory(current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function ensureDirectoryTree(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await syncDirectoryTree(directory);
}

async function ensureOperationDurable(operationPath) {
  let handle;
  try {
    handle = await open(operationPath, 'r');
    await handle.sync();
    await syncDirectoryTree(dirname(operationPath));
  } catch {
    throw new CliError(
      'Não foi possível confirmar a persistência da operação; nenhuma requisição foi enviada.',
    );
  } finally {
    await handle?.close();
  }
}

async function writeSyncedFile(filePath, contents) {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function temporaryPath(operationPath) {
  return `${operationPath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
}

async function createOperationExclusive(operationPath, operation) {
  const directory = dirname(operationPath);
  const temporary = temporaryPath(operationPath);
  let linked = false;
  try {
    await ensureDirectoryTree(directory);
    await writeSyncedFile(temporary, `${JSON.stringify(operation, null, 2)}\n`);
    try {
      await link(temporary, operationPath);
      linked = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (linked) {
      await chmod(operationPath, 0o600);
      await syncDirectory(directory);
      return operation;
    }
    return await readOperation(operationPath);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      'Não foi possível persistir a operação; nenhuma requisição foi enviada.',
    );
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function loadOrCreateOperation(operationPath, operation) {
  try {
    return await readOperation(operationPath);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    try {
      await lstat(operationPath);
      throw error;
    } catch (statError) {
      if (statError?.code !== 'ENOENT') throw error;
    }
  }
  return createOperationExclusive(operationPath, operation);
}

function assertOperationMatches(operation, input) {
  if (operation.origin !== input.origin)
    throw new CliError(
      'A origem diverge da operação existente; nenhuma requisição foi enviada.',
    );
  if (operation.credentialFingerprint !== sha256(input.token))
    throw new CliError(
      'A credencial diverge da operação existente; nenhuma requisição foi enviada.',
    );
  if (input.title !== undefined && input.title !== operation.payload.title)
    throw new CliError(
      'O título diverge da operação existente; nenhuma requisição foi enviada.',
    );
  if (
    operation.payload.byteLength !== input.bytes.byteLength ||
    operation.payload.markdownSha256 !== sha256(input.bytes) ||
    operation.payload.payloadSha256 !==
      payloadDigest(
        input.markdown,
        operation.payload.filename,
        operation.payload.title,
      )
  )
    throw new CliError(
      'O Markdown diverge da operação existente; nenhuma requisição foi enviada.',
    );
}

async function readJsonResponse(response) {
  if (response.status !== 201)
    throw new CliError(
      `O serviço recusou a publicação (HTTP ${response.status}).`,
    );
  if (
    response.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  )
    throw new CliError('O serviço retornou uma resposta inválida.');
  const reader = response.body?.getReader();
  if (!reader) throw new CliError('O serviço retornou uma resposta inválida.');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_STATE_BYTES) {
      await reader.cancel();
      throw new CliError('O serviço retornou uma resposta inválida.');
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, size);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CliError('O serviço retornou uma resposta inválida.');
  }
}

function validatePublicationUrl(input, documentId, origin) {
  if (typeof input !== 'string')
    throw new CliError('O serviço retornou uma URL inválida.');
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new CliError('O serviço retornou uma URL inválida.');
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/d/${documentId}`
  )
    throw new CliError(
      'O serviço retornou uma URL incompatível com a operação.',
    );
  return url.href;
}

function validateResult(value, origin) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['documentId', 'publicationId', 'url']) ||
    typeof value.documentId !== 'string' ||
    typeof value.publicationId !== 'string' ||
    !UUID.test(value.documentId) ||
    !UUID.test(value.publicationId)
  )
    throw new CliError('O serviço retornou identificadores inválidos.');
  return {
    documentId: value.documentId,
    publicationId: value.publicationId,
    url: validatePublicationUrl(value.url, value.documentId, origin),
  };
}

function sameResult(receipt, result) {
  return (
    receipt.documentId === result.documentId &&
    receipt.publicationId === result.publicationId &&
    receipt.url === result.url
  );
}

async function persistReceipt(operationPath, operation, result) {
  if (operation.receipt && !sameResult(operation.receipt, result))
    throw new CliError(
      'O resultado do serviço diverge do recibo já registrado.',
    );

  const completed = {
    ...operation,
    receipt: {
      ...result,
      recordedAt: operation.receipt?.recordedAt ?? new Date().toISOString(),
    },
  };
  const temporary = temporaryPath(operationPath);
  try {
    await writeSyncedFile(temporary, `${JSON.stringify(completed, null, 2)}\n`);
    const current = await readOperation(operationPath);
    if (
      current.idempotencyKey !== operation.idempotencyKey ||
      current.payload.payloadSha256 !== operation.payload.payloadSha256 ||
      current.credentialFingerprint !== operation.credentialFingerprint
    )
      throw new CliError(
        'A operação mudou enquanto a resposta era persistida.',
      );
    if (current.receipt && !sameResult(current.receipt, result))
      throw new CliError(
        'O resultado do serviço diverge do recibo já registrado.',
      );
    await rename(temporary, operationPath);
    await chmod(operationPath, 0o600);
    await syncDirectory(dirname(operationPath));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      'A publicação pode ter sido criada, mas o recibo não foi persistido. Preserve a operação e repita o mesmo comando.',
    );
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function publish(operation, markdown, token, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${operation.origin}/api/publications`, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': operation.idempotencyKey,
      },
      body: JSON.stringify({
        markdown,
        filename: operation.payload.filename,
        ...(operation.payload.title === null
          ? {}
          : { title: operation.payload.title }),
      }),
    });
    return validateResult(await readJsonResponse(response), operation.origin);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      'A tentativa não recebeu resposta. A operação foi preservada; repita o mesmo comando para consultar com a mesma chave.',
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const token = validateToken(process.env[TOKEN_ENV]);
  const timeout = timeoutFromEnvironment(process.env[TIMEOUT_ENV]);
  const { bytes, markdown } = await readMarkdown(args.file);
  validateNewMetadata(basename(args.file), args.title);
  const candidate = newOperation({
    markdown,
    bytes,
    filename: basename(args.file),
    title: args.title,
    origin: args.origin,
    token,
  });
  const operation = await loadOrCreateOperation(args.operation, candidate);
  assertOperationMatches(operation, { ...args, bytes, markdown, token });
  await ensureOperationDurable(args.operation);
  const result = await publish(operation, markdown, token, timeout);
  await persistReceipt(args.operation, operation, result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const message =
    error instanceof CliError
      ? error.message
      : 'Não foi possível concluir a publicação.';
  process.stderr.write(`Erro: ${message}\n`);
  process.exitCode = 1;
});
