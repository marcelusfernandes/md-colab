#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_CONTEXT_BYTES = 256 * 1024 * 1024;
const MAX_OPERATION_BYTES = 8 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const OPERATION_VERSION = 1;
const TOKEN_ENV = 'MD_COLAB_PLAN_TOKEN';
const TIMEOUT_ENV = 'MD_COLAB_REVISE_TIMEOUT_MS';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXISTING_ID = /^[0-9a-f-]{36}$/i;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export class CliError extends Error {}
export class UncertainResultError extends CliError {}

function usage() {
  return `Uso:
  npm run --silent revise:markdown -- --action publish --origin <origem> --document <UUID> --operation <estado.json> --context <context.json> --file <revisao.md> [--title <titulo>] [--summary <resumo>] [--considered-comment <ID>]...
  npm run --silent revise:markdown -- --action lookup --origin <origem> --document <UUID> --operation <estado.json>
  npm run --silent revise:markdown -- --action retry --origin <origem> --document <UUID> --operation <estado.json>

Variáveis:
  ${TOKEN_ENV}          credencial plan_revise mdp_... (obrigatória)
  ${TIMEOUT_ENV}  timeout de uma ação em ms (opcional; padrão ${DEFAULT_TIMEOUT_MS})`;
}

export function validateOrigin(input) {
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

function validateToken(value) {
  if (!/^mdp_[0-9a-f]{64}$/.test(value ?? ''))
    throw new CliError(`Defina uma credencial válida em ${TOKEN_ENV}.`);
  return value;
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

export function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h'))
    return null;
  const values = new Map();
  const consideredCommentIds = [];
  const allowed = new Set([
    '--action',
    '--origin',
    '--document',
    '--operation',
    '--context',
    '--file',
    '--title',
    '--summary',
    '--considered-comment',
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.length === 0)
      throw new CliError(`Argumentos inválidos.\n${usage()}`);
    if (flag === '--considered-comment') consideredCommentIds.push(value);
    else {
      if (values.has(flag)) throw new CliError(`Argumento repetido: ${flag}.`);
      values.set(flag, value);
    }
  }
  for (const required of ['--action', '--origin', '--document', '--operation'])
    if (!values.has(required))
      throw new CliError(`Falta ${required}.\n${usage()}`);
  const action = values.get('--action');
  if (!['publish', 'lookup', 'retry'].includes(action))
    throw new CliError('A ação deve ser publish, lookup ou retry.');
  const documentId = values.get('--document');
  if (!UUID.test(documentId)) throw new CliError('O UUID do plano é inválido.');
  const publishOnly = ['--context', '--file', '--title', '--summary'];
  if (action === 'publish') {
    for (const required of ['--context', '--file'])
      if (!values.has(required))
        throw new CliError(`Falta ${required} na ação publish.`);
  } else if (
    publishOnly.some((flag) => values.has(flag)) ||
    consideredCommentIds.length > 0
  ) {
    throw new CliError(
      'Lookup e retry não aceitam arquivo, contexto, título, resumo ou referências.',
    );
  }
  return {
    action,
    origin: validateOrigin(values.get('--origin')),
    documentId,
    operation: resolve(values.get('--operation')),
    context: values.has('--context') ? resolve(values.get('--context')) : null,
    file: values.has('--file') ? resolve(values.get('--file')) : null,
    title: values.get('--title'),
    summary: values.get('--summary'),
    consideredCommentIds,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validText(value) {
  return (
    typeof value === 'string' &&
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(value, 'utf8'),
    ) === value
  );
}

function nullableText(value) {
  return value === null || validText(value);
}

async function readRegularBytes(path, limit, label, operations) {
  let handle;
  try {
    const pathStat = await operations.lstat(path);
    if (!pathStat.isFile())
      throw new CliError(`${label} não é um arquivo regular.`);
    handle = await operations.open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const openedStat = await handle.stat();
    if (!openedStat.isFile())
      throw new CliError(`${label} não é um arquivo regular.`);
    if (openedStat.size > limit)
      throw new CliError(`${label} excede o limite local.`);
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const result = await handle.read(chunk, 0, chunk.byteLength, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > limit) throw new CliError(`${label} excede o limite local.`);
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Não foi possível ler ${label.toLowerCase()}.`);
  } finally {
    await handle?.close();
  }
}

function decodeJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CliError(`${label} não contém JSON UTF-8 válido.`);
  }
}

function validateConversation(value) {
  return (
    exactKeys(value, [
      'state',
      'version',
      'decision',
      'decision_reason',
      'reply_count',
    ]) &&
    ['open', 'closed'].includes(value.state) &&
    validInteger(value.version) &&
    (value.decision === null ||
      ['follow', 'refute', 'defer'].includes(value.decision)) &&
    nullableText(value.decision_reason) &&
    validInteger(value.reply_count)
  );
}

function validateContextComment(value) {
  if (
    !exactKeys(value, [
      'id',
      'root_id',
      'author_id',
      'author_name',
      'body',
      'quote',
      'source_start',
      'source_revision_id',
      'created_at',
      'is_root',
      'conversation',
    ]) ||
    !EXISTING_ID.test(value.id) ||
    !EXISTING_ID.test(value.root_id) ||
    !EXISTING_ID.test(value.author_id) ||
    !validText(value.author_name) ||
    !validText(value.body) ||
    !validText(value.quote) ||
    !(value.source_start === null || validInteger(value.source_start)) ||
    !EXISTING_ID.test(value.source_revision_id) ||
    !validDate(value.created_at) ||
    typeof value.is_root !== 'boolean' ||
    (value.is_root ? value.id !== value.root_id : value.id === value.root_id) ||
    (value.is_root
      ? !validateConversation(value.conversation)
      : value.conversation !== null)
  )
    throw new CliError('O contexto contém um comentário inválido.');
  return value;
}

function validateContextEvent(value) {
  if (
    !exactKeys(value, [
      'id',
      'root_id',
      'actor_id',
      'actor_name',
      'base_version',
      'version',
      'action',
      'state',
      'decision',
      'decision_reason',
      'reason',
      'created_at',
    ]) ||
    !EXISTING_ID.test(value.id) ||
    !EXISTING_ID.test(value.root_id) ||
    !EXISTING_ID.test(value.actor_id) ||
    !validText(value.actor_name) ||
    !validInteger(value.base_version) ||
    !validInteger(value.version, 1) ||
    value.version !== value.base_version + 1 ||
    !['close', 'reopen', 'follow', 'refute', 'defer'].includes(value.action) ||
    !['open', 'closed'].includes(value.state) ||
    !(
      value.decision === null ||
      ['follow', 'refute', 'defer'].includes(value.decision)
    ) ||
    !nullableText(value.decision_reason) ||
    !nullableText(value.reason) ||
    !validDate(value.created_at)
  )
    throw new CliError('O contexto contém um evento inválido.');
  return value;
}

function validateContextRevision(value, documentId) {
  if (
    !exactKeys(value, [
      'id',
      'document_id',
      'ordinal',
      'author_id',
      'author_name',
      'title',
      'filename',
      'base_revision_id',
      'summary',
      'considered_comment_ids',
      'created_at',
      'file',
      'byte_length',
      'sha256',
    ]) ||
    !EXISTING_ID.test(value.id) ||
    value.document_id !== documentId ||
    !validInteger(value.ordinal, 1) ||
    !EXISTING_ID.test(value.author_id) ||
    !validText(value.author_name) ||
    !validText(value.title) ||
    !validText(value.filename) ||
    !(
      value.base_revision_id === null ||
      EXISTING_ID.test(value.base_revision_id)
    ) ||
    !nullableText(value.summary) ||
    !Array.isArray(value.considered_comment_ids) ||
    value.considered_comment_ids.length > 100 ||
    value.considered_comment_ids.some((id) => !EXISTING_ID.test(id)) ||
    [...new Set(value.considered_comment_ids)].sort(compareText).join(',') !==
      value.considered_comment_ids.join(',') ||
    !validDate(value.created_at) ||
    typeof value.file !== 'string' ||
    !/^revision-[0-9a-f]{64}\.md$/.test(value.file) ||
    value.file !== `revision-${sha256(Buffer.from(value.id, 'utf8'))}.md` ||
    !validInteger(value.byte_length) ||
    value.byte_length > MAX_MARKDOWN_BYTES ||
    !HEX_DIGEST.test(value.sha256)
  )
    throw new CliError('O contexto contém um snapshot inválido.');
  return value;
}

function validateContextRelationships(context) {
  const commentsById = new Map(context.comments.map((item) => [item.id, item]));
  if (commentsById.size !== context.comments.length)
    throw new CliError('O contexto contém comentários duplicados.');
  const roots = new Map(
    context.comments
      .filter((comment) => comment.is_root)
      .map((comment) => [comment.id, comment]),
  );
  for (const comment of context.comments) {
    const root = roots.get(comment.root_id);
    if (!root) throw new CliError('O contexto referencia uma raiz ausente.');
    if (
      !comment.is_root &&
      (comment.quote !== '' ||
        comment.source_start !== null ||
        comment.source_revision_id !== root.source_revision_id)
    )
      throw new CliError('Uma resposta diverge da origem da conversa.');
  }
  for (const root of roots.values()) {
    const replies = context.comments.filter(
      (comment) => !comment.is_root && comment.root_id === root.id,
    ).length;
    if (root.conversation.reply_count !== replies)
      throw new CliError('A contagem de respostas do contexto diverge.');
  }
  const eventIds = new Set();
  const eventsByRoot = new Map();
  for (const event of context.events) {
    if (eventIds.has(event.id))
      throw new CliError('O contexto contém eventos duplicados.');
    eventIds.add(event.id);
    if (!roots.has(event.root_id))
      throw new CliError('O contexto contém evento sem conversa.');
    const chain = eventsByRoot.get(event.root_id) ?? [];
    const previous = chain.at(-1);
    if (event.base_version !== (previous?.version ?? 0))
      throw new CliError('A sequência de eventos do contexto diverge.');
    const priorState = previous?.state ?? 'open';
    const priorDecision = previous?.decision ?? null;
    const priorDecisionReason = previous?.decision_reason ?? null;
    const isDecision = ['follow', 'refute', 'defer'].includes(event.action);
    const expectedState =
      event.action === 'close'
        ? 'closed'
        : event.action === 'reopen'
          ? 'open'
          : priorState;
    const expectedDecision = isDecision ? event.action : priorDecision;
    const expectedDecisionReason = isDecision
      ? event.reason
      : priorDecisionReason;
    if (
      event.state !== expectedState ||
      event.decision !== expectedDecision ||
      event.decision_reason !== expectedDecisionReason
    )
      throw new CliError('Uma transição do contexto diverge de sua projeção.');
    chain.push(event);
    eventsByRoot.set(event.root_id, chain);
  }
  for (const root of roots.values()) {
    const last = eventsByRoot.get(root.id)?.at(-1);
    const expected = last
      ? [last.state, last.version, last.decision, last.decision_reason]
      : ['open', 0, null, null];
    const actual = [
      root.conversation.state,
      root.conversation.version,
      root.conversation.decision,
      root.conversation.decision_reason,
    ];
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new CliError('A projeção de conversa do contexto diverge.');
  }
  const revisionsById = new Map(
    context.revisions.map((revision) => [revision.id, revision]),
  );
  if (revisionsById.size !== context.revisions.length)
    throw new CliError('O contexto contém snapshots duplicados.');
  const expectedRevisionIds = new Set([
    context.document.current_revision_id,
    ...context.comments.map((comment) => comment.source_revision_id),
  ]);
  if (
    expectedRevisionIds.size !== revisionsById.size ||
    [...expectedRevisionIds].some((id) => !revisionsById.has(id))
  )
    throw new CliError('A cobertura de snapshots do contexto diverge.');
  for (const revision of context.revisions)
    for (const id of revision.considered_comment_ids)
      if (!commentsById.has(id))
        throw new CliError('Um snapshot considera comentário não exportado.');
  const current = revisionsById.get(context.document.current_revision_id);
  if (
    !current ||
    current.ordinal !== context.document.current_revision_ordinal ||
    current.title !== context.document.title ||
    current.filename !== context.document.filename ||
    context.document.current_revision_ordinal !==
      context.document.counts.revisions ||
    context.revisions.some(
      (revision) => revision.ordinal > context.document.counts.revisions,
    ) ||
    new Set(context.revisions.map((revision) => revision.ordinal)).size !==
      context.revisions.length
  )
    throw new CliError('A revisão corrente do contexto diverge do plano.');
}

export function validateContext(value, origin, documentId) {
  if (
    !exactKeys(value, [
      'schema_version',
      'origin',
      'export',
      'semantics',
      'document',
      'comments',
      'events',
      'revisions',
      'comparison',
    ]) ||
    value.schema_version !== 1 ||
    value.origin !== origin ||
    validateOrigin(value.origin) !== value.origin ||
    !exactKeys(value.export, [
      'complete',
      'validated_at',
      'snapshot_coverage',
      'full_revision_history',
    ]) ||
    value.export.complete !== true ||
    !validDate(value.export.validated_at) ||
    value.export.snapshot_coverage !== 'current_and_comment_origins' ||
    value.export.full_revision_history !== false ||
    !exactKeys(value.semantics, [
      'source_start',
      'closed_conversation_is_approval',
      'execution_authorized',
      'considered_comment_ids',
    ]) ||
    value.semantics.source_start !== 'renderer_block_anchor' ||
    value.semantics.closed_conversation_is_approval !== false ||
    value.semantics.execution_authorized !== false ||
    value.semantics.considered_comment_ids !== 'author_marked_as_considered' ||
    !exactKeys(value.document, [
      'id',
      'title',
      'filename',
      'current_revision_id',
      'current_revision_ordinal',
      'counts',
    ]) ||
    value.document.id !== documentId ||
    !EXISTING_ID.test(value.document.id) ||
    !validText(value.document.title) ||
    !validText(value.document.filename) ||
    !EXISTING_ID.test(value.document.current_revision_id) ||
    !validInteger(value.document.current_revision_ordinal, 1) ||
    !exactKeys(value.document.counts, ['comments', 'events', 'revisions']) ||
    !validInteger(value.document.counts.comments) ||
    !validInteger(value.document.counts.events) ||
    !validInteger(value.document.counts.revisions, 1) ||
    !Array.isArray(value.comments) ||
    value.comments.length > 10_000 ||
    value.document.counts.comments !== value.comments.length ||
    !Array.isArray(value.events) ||
    value.events.length > 10_000 ||
    value.document.counts.events !== value.events.length ||
    !Array.isArray(value.revisions) ||
    value.revisions.length === 0 ||
    value.revisions.length > 1_000
  )
    throw new CliError('O contexto de feedback é inválido ou incompatível.');
  value.comments.forEach(validateContextComment);
  value.events.forEach(validateContextEvent);
  value.revisions.forEach((revision) =>
    validateContextRevision(revision, documentId),
  );
  const comparisonKeys =
    value.comparison && Object.hasOwn(value.comparison, 'local_file')
      ? ['status', 'revision_id', 'local_file']
      : ['status', 'revision_id'];
  if (
    !exactKeys(value.comparison, comparisonKeys) ||
    !['identical', 'different', 'not_compared'].includes(
      value.comparison.status,
    ) ||
    value.comparison.revision_id !== value.document.current_revision_id ||
    (Object.hasOwn(value.comparison, 'local_file') &&
      (!exactKeys(value.comparison.local_file, ['byteLength', 'sha256']) ||
        !validInteger(value.comparison.local_file.byteLength) ||
        value.comparison.local_file.byteLength > MAX_MARKDOWN_BYTES ||
        !HEX_DIGEST.test(value.comparison.local_file.sha256))) ||
    (value.comparison.status === 'not_compared' &&
      Object.hasOwn(value.comparison, 'local_file')) ||
    (value.comparison.status !== 'not_compared' &&
      !Object.hasOwn(value.comparison, 'local_file'))
  )
    throw new CliError('A comparação do contexto é inválida.');
  validateContextRelationships(value);
  return value;
}

async function readContext(path, origin, documentId, operations) {
  const bytes = await readRegularBytes(
    path,
    MAX_CONTEXT_BYTES,
    'O contexto de feedback',
    operations,
  );
  return validateContext(
    decodeJson(bytes, 'O contexto de feedback'),
    origin,
    documentId,
  );
}

async function readMarkdown(path, operations) {
  const bytes = await readRegularBytes(
    path,
    MAX_MARKDOWN_BYTES,
    'O Markdown selecionado',
    operations,
  );
  let markdown;
  try {
    markdown = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new CliError('O Markdown selecionado não é UTF-8 válido.');
  }
  if (!markdown.trim()) throw new CliError('O Markdown não pode ficar vazio.');
  return { bytes, markdown };
}

function effectiveMetadata(markdown, file, titleInput, summaryInput) {
  const filename = basename(file).trim();
  if (!filename || filename.length > 255)
    throw new CliError('O nome do arquivo deve ter entre 1 e 255 caracteres.');
  let title;
  if (titleInput !== undefined) {
    title = titleInput.trim();
    if (!title || titleInput.length > 240 || title.length > 240)
      throw new CliError('O título deve ter entre 1 e 240 caracteres.');
  } else {
    const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
    title = (heading || filename.replace(/\.(md|markdown)$/i, '')).slice(
      0,
      240,
    );
    if (!title) throw new CliError('O título derivado é inválido.');
  }
  const summary = summaryInput?.trim() || null;
  if (summaryInput !== undefined && summaryInput.length > 2000)
    throw new CliError('O resumo deve ter no máximo 2000 caracteres.');
  return { filename, title, summary };
}

function canonicalReferences(ids, context) {
  if (ids.some((id) => !EXISTING_ID.test(id)))
    throw new CliError('Uma referência de comentário é inválida.');
  const references = [...new Set(ids)].sort(compareText);
  if (references.length > 100)
    throw new CliError('Selecione no máximo 100 comentários considerados.');
  const available = new Set(context.comments.map((comment) => comment.id));
  if (references.some((id) => !available.has(id)))
    throw new CliError(
      'Uma referência não está presente no contexto escolhido.',
    );
  return references;
}

function operationPayloadDigest(operation) {
  return sha256(
    JSON.stringify([
      operation.origin,
      operation.documentId,
      operation.revisionId,
      operation.payload.baseRevisionId,
      operation.payload.markdown,
      operation.payload.markdownSha256,
      operation.payload.byteLength,
      operation.payload.filename,
      operation.payload.title,
      operation.payload.summary,
      operation.payload.consideredCommentIds,
    ]),
  );
}

export function createOperation({
  origin,
  documentId,
  context,
  markdown,
  bytes,
  file,
  title,
  summary,
  consideredCommentIds,
  revisionId = randomUUID(),
  createdAt = new Date().toISOString(),
}) {
  const metadata = effectiveMetadata(markdown, file, title, summary);
  const operation = {
    version: OPERATION_VERSION,
    origin,
    documentId,
    revisionId,
    payload: {
      baseRevisionId: context.document.current_revision_id,
      markdown,
      markdownSha256: sha256(bytes),
      byteLength: bytes.byteLength,
      ...metadata,
      consideredCommentIds: canonicalReferences(consideredCommentIds, context),
    },
    payloadSha256: '',
    createdAt,
  };
  operation.payloadSha256 = operationPayloadDigest(operation);
  return operation;
}

function validateReceipt(receipt) {
  if (
    !exactKeys(receipt, ['ordinal', 'authorId', 'createdAt', 'recordedAt']) ||
    !validInteger(receipt.ordinal, 1) ||
    !EXISTING_ID.test(receipt.authorId) ||
    !validDate(receipt.createdAt) ||
    !validDate(receipt.recordedAt)
  )
    throw new CliError('O recibo salvo na operação é inválido.');
  return receipt;
}

export function validateOperation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CliError('O arquivo de operação é inválido.');
  const hasReceipt = Object.hasOwn(value, 'receipt');
  if (
    !exactKeys(value, [
      'version',
      'origin',
      'documentId',
      'revisionId',
      'payload',
      'payloadSha256',
      'createdAt',
      ...(hasReceipt ? ['receipt'] : []),
    ]) ||
    value.version !== OPERATION_VERSION ||
    validateOrigin(value.origin) !== value.origin ||
    !UUID.test(value.documentId) ||
    !UUID.test(value.revisionId) ||
    !exactKeys(value.payload, [
      'baseRevisionId',
      'markdown',
      'markdownSha256',
      'byteLength',
      'filename',
      'title',
      'summary',
      'consideredCommentIds',
    ]) ||
    !UUID.test(value.payload.baseRevisionId) ||
    !validText(value.payload.markdown) ||
    !value.payload.markdown.trim() ||
    !HEX_DIGEST.test(value.payload.markdownSha256) ||
    !validInteger(value.payload.byteLength, 1) ||
    value.payload.byteLength > MAX_MARKDOWN_BYTES ||
    Buffer.byteLength(value.payload.markdown, 'utf8') !==
      value.payload.byteLength ||
    sha256(Buffer.from(value.payload.markdown, 'utf8')) !==
      value.payload.markdownSha256 ||
    !validText(value.payload.filename) ||
    !value.payload.filename.trim() ||
    value.payload.filename !== value.payload.filename.trim() ||
    value.payload.filename.length > 255 ||
    !validText(value.payload.title) ||
    !value.payload.title.trim() ||
    value.payload.title !== value.payload.title.trim() ||
    value.payload.title.length > 240 ||
    !(
      value.payload.summary === null ||
      (validText(value.payload.summary) &&
        value.payload.summary.trim() &&
        value.payload.summary === value.payload.summary.trim() &&
        value.payload.summary.length <= 2000)
    ) ||
    !Array.isArray(value.payload.consideredCommentIds) ||
    value.payload.consideredCommentIds.length > 100 ||
    value.payload.consideredCommentIds.some((id) => !EXISTING_ID.test(id)) ||
    [...new Set(value.payload.consideredCommentIds)]
      .sort(compareText)
      .join(',') !== value.payload.consideredCommentIds.join(',') ||
    !HEX_DIGEST.test(value.payloadSha256) ||
    operationPayloadDigest(value) !== value.payloadSha256 ||
    !validDate(value.createdAt)
  )
    throw new CliError('O arquivo de operação é inválido.');
  if (hasReceipt) validateReceipt(value.receipt);
  return value;
}

async function readOperation(path, operations) {
  return validateOperation(
    decodeJson(
      await readRegularBytes(
        path,
        MAX_OPERATION_BYTES,
        'O arquivo de operação',
        operations,
      ),
      'O arquivo de operação',
    ),
  );
}

async function syncDirectory(path, operations) {
  const handle = await operations.open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryTree(path, operations) {
  let current = resolve(path);
  for (;;) {
    await syncDirectory(current, operations);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function ensureDirectoryTree(path, operations) {
  await operations.mkdir(path, { recursive: true, mode: 0o700 });
  await syncDirectoryTree(path, operations);
}

function temporaryPath(path) {
  return `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
}

async function writeSynced(path, contents, operations) {
  const handle = await operations.open(path, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertNewOperationPath(path, operations) {
  try {
    await operations.lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new CliError('Não foi possível verificar o destino da operação.');
  }
  throw new CliError(
    'A operação já existe. Use --action lookup ou --action retry sem alterar seus dados.',
  );
}

async function createOperationExclusive(path, operation, operations) {
  const directory = dirname(path);
  const temporary = temporaryPath(path);
  let linked = false;
  try {
    await ensureDirectoryTree(directory, operations);
    await writeSynced(
      temporary,
      Buffer.from(`${JSON.stringify(operation, null, 2)}\n`, 'utf8'),
      operations,
    );
    try {
      await operations.link(temporary, path);
      linked = true;
    } catch (error) {
      if (error?.code === 'EEXIST')
        throw new CliError(
          'Outra invocação criou a operação. Nenhuma requisição foi enviada; use --action lookup ou --action retry.',
        );
      throw error;
    }
    await operations.chmod(path, 0o600);
    await syncDirectory(directory, operations);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      'Não foi possível persistir a operação; nenhuma requisição foi enviada.',
    );
  } finally {
    await operations.unlink(temporary).catch(() => {});
  }
  if (!linked) throw new CliError('A operação não foi publicada.');
}

async function ensureOperationDurable(path, operations) {
  let handle;
  try {
    handle = await operations.open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error();
    await handle.sync();
    await syncDirectoryTree(dirname(path), operations);
  } catch {
    throw new CliError(
      'Não foi possível confirmar a persistência da operação; nenhuma requisição foi enviada.',
    );
  } finally {
    await handle?.close();
  }
}

function publicPayload(operation) {
  return {
    id: operation.revisionId,
    baseRevisionId: operation.payload.baseRevisionId,
    markdown: operation.payload.markdown,
    filename: operation.payload.filename,
    title: operation.payload.title,
    summary: operation.payload.summary,
    consideredCommentIds: operation.payload.consideredCommentIds,
  };
}

function serializedPayload(operation) {
  const serialized = JSON.stringify(publicPayload(operation));
  if (Buffer.byteLength(serialized, 'utf8') > MAX_HTTP_BODY_BYTES)
    throw new CliError(
      'O payload JSON excede 2 MiB; nenhuma requisição foi enviada.',
    );
  return serialized;
}

function validateConsideredComment(value) {
  return (
    exactKeys(value, [
      'id',
      'root_id',
      'source_revision_id',
      'author_id',
      'author_name',
      'body',
      'quote',
      'created_at',
    ]) &&
    EXISTING_ID.test(value.id) &&
    EXISTING_ID.test(value.root_id) &&
    EXISTING_ID.test(value.source_revision_id) &&
    EXISTING_ID.test(value.author_id) &&
    validText(value.author_name) &&
    validText(value.body) &&
    validText(value.quote) &&
    validDate(value.created_at)
  );
}

function validateRevisionEnvelope(value, operation) {
  if (!exactKeys(value, ['revision']))
    throw new CliError('O serviço retornou um recibo inválido.');
  const revision = value.revision;
  if (
    !exactKeys(revision, [
      'id',
      'document_id',
      'ordinal',
      'author_id',
      'title',
      'filename',
      'markdown',
      'base_revision_id',
      'summary',
      'considered_comment_ids',
      'considered_comments',
      'created_at',
    ]) ||
    revision.id !== operation.revisionId ||
    revision.document_id !== operation.documentId ||
    !validInteger(revision.ordinal, 1) ||
    !EXISTING_ID.test(revision.author_id) ||
    revision.title !== operation.payload.title ||
    revision.filename !== operation.payload.filename ||
    revision.markdown !== operation.payload.markdown ||
    revision.base_revision_id !== operation.payload.baseRevisionId ||
    revision.summary !== operation.payload.summary ||
    !Array.isArray(revision.considered_comment_ids) ||
    revision.considered_comment_ids.join(',') !==
      operation.payload.consideredCommentIds.join(',') ||
    !Array.isArray(revision.considered_comments) ||
    revision.considered_comments.length !==
      revision.considered_comment_ids.length ||
    revision.considered_comments.some(
      (comment, index) =>
        !validateConsideredComment(comment) ||
        comment.id !== revision.considered_comment_ids[index],
    ) ||
    !validDate(revision.created_at)
  )
    throw new CliError('O serviço não confirmou o payload desta operação.');
  return revision;
}

function requestFailure(status, action) {
  if (action === 'lookup' && status === 404)
    return new CliError(
      'O recibo não foi observado (HTTP 404). Outra requisição ainda pode estar em andamento; preserve a operação e consulte novamente depois.',
    );
  if (status === 409)
    return new CliError(
      'O serviço recusou a revisão por conflito (HTTP 409). Preserve a operação; uma nova base ou conteúdo exige outra operação.',
    );
  if (status === 403)
    return new CliError(
      'A conta não está habilitada para publicar esta revisão (HTTP 403). O recibo ainda pode ser consultado com --action lookup.',
    );
  if (status === 401)
    return new CliError('A credencial plan_revise foi recusada (HTTP 401).');
  return new CliError(`O serviço recusou a ação (HTTP ${status}).`);
}

async function responseJson(response, action) {
  const accepted = action === 'lookup' ? [200] : [200, 201];
  if (!accepted.includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    throw requestFailure(response.status, action);
  }
  if (
    response.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  ) {
    await response.body?.cancel().catch(() => {});
    throw new CliError('O serviço retornou uma resposta inválida.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CliError('O serviço retornou uma resposta inválida.');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new CliError('A resposta excedeu o limite local.');
    }
    chunks.push(value);
  }
  return decodeJson(Buffer.concat(chunks, size), 'A resposta do serviço');
}

async function requestRevision(operation, token, timeout, action, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const url = `${operation.origin}/api/agent/documents/${encodeURIComponent(operation.documentId)}/revisions${action === 'lookup' ? `/${encodeURIComponent(operation.revisionId)}` : ''}`;
  try {
    const response = await fetchImpl(url, {
      method: action === 'lookup' ? 'GET' : 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(action === 'lookup' ? {} : { 'content-type': 'application/json' }),
      },
      ...(action === 'lookup' ? {} : { body: serializedPayload(operation) }),
    });
    try {
      return validateRevisionEnvelope(
        await responseJson(response, action),
        operation,
      );
    } catch (error) {
      if (
        action !== 'lookup' &&
        [200, 201].includes(response.status) &&
        error instanceof CliError
      )
        throw new UncertainResultError(
          'O serviço aceitou a requisição, mas a confirmação recebida é inválida. Preserve a operação e use --action lookup.',
        );
      throw error;
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (controller.signal.aborted)
      throw new UncertainResultError(
        'A ação excedeu o timeout. Preserve a operação; use --action lookup antes de decidir por --action retry.',
      );
    throw new UncertainResultError(
      'A ação não recebeu resposta. Preserve a operação; use --action lookup antes de decidir por --action retry.',
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function receiptFromRevision(revision, previous) {
  return {
    ordinal: revision.ordinal,
    authorId: revision.author_id,
    createdAt: revision.created_at,
    recordedAt: previous?.recordedAt ?? revision.created_at,
  };
}

function sameReceipt(left, right) {
  return (
    left.ordinal === right.ordinal &&
    left.authorId === right.authorId &&
    left.createdAt === right.createdAt
  );
}

function sameOperation(left, right) {
  return (
    left.version === right.version &&
    left.origin === right.origin &&
    left.documentId === right.documentId &&
    left.revisionId === right.revisionId &&
    left.createdAt === right.createdAt &&
    left.payloadSha256 === right.payloadSha256 &&
    JSON.stringify(left.payload) === JSON.stringify(right.payload)
  );
}

async function persistReceipt(path, operation, revision, operations) {
  const receipt = receiptFromRevision(revision, operation.receipt);
  const completed = { ...operation, receipt };
  const temporary = temporaryPath(path);
  try {
    if (operation.receipt && !sameReceipt(operation.receipt, receipt))
      throw new Error('saved receipt differs');
    await writeSynced(
      temporary,
      Buffer.from(`${JSON.stringify(completed, null, 2)}\n`, 'utf8'),
      operations,
    );
    const current = await readOperation(path, operations);
    if (!sameOperation(current, operation))
      throw new Error('operation changed');
    if (current.receipt && !sameReceipt(current.receipt, receipt))
      throw new Error('receipt changed');
    await operations.rename(temporary, path);
    await operations.chmod(path, 0o600);
    await syncDirectory(dirname(path), operations);
  } catch {
    throw new UncertainResultError(
      'A revisão foi confirmada, mas o recibo não foi persistido. Preserve a operação e use --action lookup.',
    );
  } finally {
    await operations.unlink(temporary).catch(() => {});
  }
}

async function writeStdout(value) {
  await new Promise((resolveWrite, rejectWrite) => {
    const onError = (error) => rejectWrite(error);
    process.stdout.once('error', onError);
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      process.stdout.off('error', onError);
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

function assertOperationTarget(operation, input) {
  if (operation.origin !== input.origin)
    throw new CliError('A origem diverge da operação existente.');
  if (operation.documentId !== input.documentId)
    throw new CliError('O plano diverge da operação existente.');
}

function outputFor(input, operation, revision) {
  return {
    action: input.action,
    origin: operation.origin,
    documentId: operation.documentId,
    revisionId: operation.revisionId,
    ordinal: revision.ordinal,
    baseRevisionId: operation.payload.baseRevisionId,
    url: `${operation.origin}/d/${operation.documentId}?revision=${operation.revisionId}`,
    operation: input.operation,
  };
}

const defaultOperations = { chmod, link, lstat, mkdir, open, rename, unlink };

export async function run(
  argv,
  environment = process.env,
  {
    operations = defaultOperations,
    fetchImpl = fetch,
    stdout = writeStdout,
  } = {},
) {
  const input = parseArguments(argv);
  if (!input) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const token = validateToken(environment[TOKEN_ENV]);
  const timeout = timeoutFromEnvironment(environment[TIMEOUT_ENV]);
  let operation;
  if (input.action === 'publish') {
    await assertNewOperationPath(input.operation, operations);
    const context = await readContext(
      input.context,
      input.origin,
      input.documentId,
      operations,
    );
    const markdown = await readMarkdown(input.file, operations);
    operation = createOperation({
      ...input,
      context,
      ...markdown,
    });
    serializedPayload(operation);
    await createOperationExclusive(input.operation, operation, operations);
  } else {
    operation = await readOperation(input.operation, operations);
    assertOperationTarget(operation, input);
    serializedPayload(operation);
  }
  await ensureOperationDurable(input.operation, operations);
  const revision = await requestRevision(
    operation,
    token,
    timeout,
    input.action,
    fetchImpl,
  );
  await persistReceipt(input.operation, operation, revision, operations);
  const output = outputFor(input, operation, revision);
  try {
    await stdout(output);
  } catch {
    throw new CliError(
      'A revisão foi confirmada e o recibo foi salvo, mas não foi possível escrever a confirmação em stdout. Consulte a operação.',
    );
  }
  return output;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  run(process.argv.slice(2)).catch((error) => {
    const message =
      error instanceof CliError
        ? error.message
        : 'Não foi possível concluir a ação de revisão.';
    process.stderr.write(`Erro: ${message}\n`);
    process.exitCode = 1;
  });
