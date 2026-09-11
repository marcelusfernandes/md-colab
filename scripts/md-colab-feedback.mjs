#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LOCAL_MARKDOWN_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RECEIVED_BYTES = 256 * 1024 * 1024;
const MAX_COLLECTION_RECORDS = 10_000;
const MAX_SNAPSHOTS = 1_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const TOKEN_ENV = 'MD_COLAB_PLAN_TOKEN';
const TIMEOUT_ENV = 'MD_COLAB_FEEDBACK_TIMEOUT_MS';
const UUID = /^[0-9a-f-]{36}$/i;

export class CliError extends Error {}
export class CommittedBundleError extends CliError {}

function usage() {
  return `Uso:
  npm run --silent feedback:markdown -- --origin <origem> --document <UUID> --output <diretorio-novo> [--file <Markdown-local>]

Variáveis:
  ${TOKEN_ENV}              credencial plan_read mdp_... (obrigatória)
  ${TIMEOUT_ENV}  timeout por requisição em ms (opcional; padrão ${DEFAULT_TIMEOUT_MS})`;
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

function validUuid(value) {
  return typeof value === 'string' && UUID.test(value);
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
  const allowed = new Set(['--origin', '--document', '--output', '--file']);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.length === 0)
      throw new CliError(`Argumentos inválidos.\n${usage()}`);
    if (values.has(flag)) throw new CliError(`Argumento repetido: ${flag}.`);
    values.set(flag, value);
  }
  for (const required of ['--origin', '--document', '--output'])
    if (!values.has(required))
      throw new CliError(`Falta ${required}.\n${usage()}`);
  const documentId = values.get('--document');
  if (!validUuid(documentId)) throw new CliError('O UUID do plano é inválido.');
  return {
    origin: validateOrigin(values.get('--origin')),
    documentId,
    output: resolve(values.get('--output')),
    file: values.has('--file') ? resolve(values.get('--file')) : null,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

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
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

async function syncDirectory(path, operations) {
  const handle = await operations.open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function reserveOutput(output, operations = defaultOperations) {
  const parent = dirname(output);
  let created = false;
  try {
    const parentStat = await operations.lstat(parent);
    if (!parentStat.isDirectory()) throw new Error();
    await operations.mkdir(output, { recursive: false, mode: 0o700 });
    created = true;
    await operations.chmod(output, 0o700);
    await syncDirectory(parent, operations);
    await syncDirectory(output, operations);
  } catch {
    if (created)
      throw new CliError(
        'O diretório de saída foi reservado, mas sua persistência não foi confirmada; preserve-o como incompleto.',
      );
    throw new CliError(
      'O diretório de saída deve ser novo e ter um diretório pai existente; nada foi sobrescrito.',
    );
  }
}

export async function readLocalMarkdown(path, operations = defaultOperations) {
  let handle;
  try {
    const pathStat = await operations.lstat(path);
    if (!pathStat.isFile())
      throw new CliError('O Markdown local não é um arquivo regular.');
    handle = await operations.open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new CliError('O Markdown local não é um arquivo regular.');
    if (stat.size > MAX_LOCAL_MARKDOWN_BYTES)
      throw new CliError('O Markdown local deve ter no máximo 1 MiB.');
    const buffer = Buffer.allocUnsafe(MAX_LOCAL_MARKDOWN_BYTES + 1);
    let byteLength = 0;
    while (byteLength < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        byteLength,
        buffer.byteLength - byteLength,
        byteLength,
      );
      if (result.bytesRead === 0) break;
      byteLength += result.bytesRead;
    }
    if (byteLength > MAX_LOCAL_MARKDOWN_BYTES)
      throw new CliError('O Markdown local deve ter no máximo 1 MiB.');
    const bytes = buffer.subarray(0, byteLength);
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new CliError('O Markdown local não é UTF-8 válido.');
    }
    return { byteLength: bytes.byteLength, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Não foi possível ler o Markdown local selecionado.');
  } finally {
    await handle?.close();
  }
}

function validateStamp(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(value))
    throw new CliError('O serviço retornou um selo de feedback inválido.');
  return value;
}

function validateCursor(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(value))
    throw new CliError('O serviço retornou um cursor de feedback inválido.');
  return value;
}

function validateManifest(value, documentId) {
  if (
    !exactKeys(value, ['contract_version', 'document', 'counts', 'stamp']) ||
    value.contract_version !== 1 ||
    !exactKeys(value.document, [
      'id',
      'title',
      'filename',
      'current_revision_id',
      'current_revision_ordinal',
    ]) ||
    value.document.id !== documentId ||
    !validUuid(value.document.id) ||
    typeof value.document.title !== 'string' ||
    typeof value.document.filename !== 'string' ||
    !validUuid(value.document.current_revision_id) ||
    !validInteger(value.document.current_revision_ordinal, 1) ||
    !exactKeys(value.counts, ['comments', 'events', 'revisions']) ||
    !validInteger(value.counts.comments) ||
    !validInteger(value.counts.events) ||
    !validInteger(value.counts.revisions, 1)
  )
    throw new CliError('O serviço retornou um manifesto de feedback inválido.');
  if (
    value.counts.comments > MAX_COLLECTION_RECORDS ||
    value.counts.events > MAX_COLLECTION_RECORDS
  )
    throw new CliError(
      'A coleta excede o limite local de 10000 comentários ou eventos.',
    );
  validateStamp(value.stamp);
  return value;
}

function validateNullableText(value) {
  return value === null || typeof value === 'string';
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
    validateNullableText(value.decision_reason) &&
    validInteger(value.reply_count)
  );
}

function validateComment(value) {
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
    !validUuid(value.id) ||
    !validUuid(value.root_id) ||
    !validUuid(value.author_id) ||
    typeof value.author_name !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.quote !== 'string' ||
    !(value.source_start === null || validInteger(value.source_start)) ||
    !validUuid(value.source_revision_id) ||
    !validDate(value.created_at) ||
    typeof value.is_root !== 'boolean' ||
    (value.is_root ? value.id !== value.root_id : value.id === value.root_id) ||
    (value.is_root
      ? !validateConversation(value.conversation)
      : value.conversation !== null)
  )
    throw new CliError('O serviço retornou um comentário inválido.');
  return value;
}

function validateEvent(value) {
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
    !validUuid(value.id) ||
    !validUuid(value.root_id) ||
    !validUuid(value.actor_id) ||
    typeof value.actor_name !== 'string' ||
    !validInteger(value.base_version) ||
    !validInteger(value.version, 1) ||
    value.version !== value.base_version + 1 ||
    !['close', 'reopen', 'follow', 'refute', 'defer'].includes(value.action) ||
    !['open', 'closed'].includes(value.state) ||
    !(
      value.decision === null ||
      ['follow', 'refute', 'defer'].includes(value.decision)
    ) ||
    !validateNullableText(value.decision_reason) ||
    !validateNullableText(value.reason) ||
    !validDate(value.created_at)
  )
    throw new CliError('O serviço retornou um evento de feedback inválido.');
  return value;
}

function validatePage(value, collection, stamp) {
  if (
    !exactKeys(value, [collection, 'next_cursor', 'stamp']) ||
    value.stamp !== stamp
  )
    throw new CliError(
      'O serviço retornou uma página de feedback incompatível.',
    );
  if (!Array.isArray(value[collection]))
    throw new CliError('O serviço retornou uma página de feedback inválida.');
  if (value[collection].length > 50)
    throw new CliError(
      'O serviço retornou uma página acima do limite de 50 itens.',
    );
  const nextCursor = validateCursor(value.next_cursor);
  if (nextCursor !== null && value[collection].length === 0)
    throw new CliError('O serviço retornou uma página vazia com continuação.');
  return { items: value[collection], nextCursor };
}

function validateRevision(value, documentId, revisionId, stamp) {
  if (!exactKeys(value, ['revision', 'stamp']) || value.stamp !== stamp)
    throw new CliError('O serviço retornou um snapshot incompatível.');
  const revision = value.revision;
  if (
    !exactKeys(revision, [
      'id',
      'document_id',
      'ordinal',
      'author_id',
      'author_name',
      'title',
      'filename',
      'markdown',
      'base_revision_id',
      'summary',
      'considered_comment_ids',
      'created_at',
    ]) ||
    revision.id !== revisionId ||
    revision.document_id !== documentId ||
    !validUuid(revision.id) ||
    !validInteger(revision.ordinal, 1) ||
    !validUuid(revision.author_id) ||
    typeof revision.author_name !== 'string' ||
    typeof revision.title !== 'string' ||
    typeof revision.filename !== 'string' ||
    typeof revision.markdown !== 'string' ||
    Buffer.byteLength(revision.markdown, 'utf8') > MAX_LOCAL_MARKDOWN_BYTES ||
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(revision.markdown, 'utf8'),
    ) !== revision.markdown ||
    !(
      revision.base_revision_id === null || validUuid(revision.base_revision_id)
    ) ||
    !validateNullableText(revision.summary) ||
    !Array.isArray(revision.considered_comment_ids) ||
    revision.considered_comment_ids.length > 100 ||
    revision.considered_comment_ids.some((id) => !validUuid(id)) ||
    new Set(revision.considered_comment_ids).size !==
      revision.considered_comment_ids.length ||
    !validDate(revision.created_at)
  )
    throw new CliError('O serviço retornou um snapshot inválido.');
  return revision;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateRelationships(manifest, comments, events, revisions) {
  const commentsById = new Map(
    comments.map((comment) => [comment.id, comment]),
  );
  const roots = new Map(
    comments
      .filter((comment) => comment.is_root)
      .map((comment) => [comment.id, comment]),
  );
  for (const comment of comments) {
    if (!roots.has(comment.root_id))
      throw new CliError('O feedback referencia uma raiz ausente.');
    if (!comment.is_root) {
      const root = roots.get(comment.root_id);
      if (
        comment.quote !== '' ||
        comment.source_start !== null ||
        comment.source_revision_id !== root.source_revision_id
      )
        throw new CliError(
          'Uma resposta diverge da origem preservada pela conversa.',
        );
    }
  }
  for (const root of roots.values()) {
    const replies = comments.filter(
      (comment) => !comment.is_root && comment.root_id === root.id,
    ).length;
    if (root.conversation.reply_count !== replies)
      throw new CliError(
        'A contagem de respostas diverge do feedback exportado.',
      );
  }
  const eventsByRoot = new Map();
  for (const event of events) {
    if (!roots.has(event.root_id))
      throw new CliError('Um evento referencia uma conversa ausente.');
    const chain = eventsByRoot.get(event.root_id) ?? [];
    const previous = chain.at(-1);
    if (event.base_version !== (previous?.version ?? 0))
      throw new CliError(
        'O histórico de uma conversa tem versões divergentes.',
      );
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
      throw new CliError(
        'Um evento diverge da transição registrada para a conversa.',
      );
    chain.push(event);
    eventsByRoot.set(event.root_id, chain);
  }
  for (const root of roots.values()) {
    const last = eventsByRoot.get(root.id)?.at(-1);
    const expected = last
      ? {
          state: last.state,
          version: last.version,
          decision: last.decision,
          decision_reason: last.decision_reason,
        }
      : { state: 'open', version: 0, decision: null, decision_reason: null };
    const actual = {
      state: root.conversation.state,
      version: root.conversation.version,
      decision: root.conversation.decision,
      decision_reason: root.conversation.decision_reason,
    };
    if (!sameJson(actual, expected))
      throw new CliError('A projeção atual diverge do histórico da conversa.');
  }
  for (const revision of revisions)
    for (const id of revision.considered_comment_ids)
      if (!commentsById.has(id))
        throw new CliError(
          'Uma revisão considera um comentário não exportado.',
        );
  const current = revisions.find(
    (revision) => revision.id === manifest.document.current_revision_id,
  );
  if (
    !current ||
    current.ordinal !== manifest.document.current_revision_ordinal ||
    current.title !== manifest.document.title ||
    current.filename !== manifest.document.filename
  )
    throw new CliError('O snapshot corrente diverge do manifesto.');
  if (
    manifest.document.current_revision_ordinal !== manifest.counts.revisions ||
    revisions.length > manifest.counts.revisions ||
    revisions.some(
      (revision) => revision.ordinal > manifest.counts.revisions,
    ) ||
    new Set(revisions.map((revision) => revision.ordinal)).size !==
      revisions.length
  )
    throw new CliError('Os snapshots divergem da história observada do plano.');
  if (
    manifest.counts.comments !== comments.length ||
    manifest.counts.events !== events.length
  )
    throw new CliError(
      'As contagens do manifesto divergem das páginas recebidas.',
    );
}

function requestFailure(status) {
  if (status === 409)
    return new CliError(
      'O feedback mudou durante a coleta; use outro diretório e tente novamente.',
    );
  if (status === 401)
    return new CliError('A credencial de leitura foi recusada ou revogada.');
  return new CliError(`O serviço recusou a coleta (HTTP ${status}).`);
}

export class FeedbackClient {
  constructor({ origin, documentId, token, timeout, fetchImpl = fetch }) {
    this.origin = origin;
    this.documentId = documentId;
    this.token = token;
    this.timeout = timeout;
    this.fetchImpl = fetchImpl;
    this.received = 0;
  }

  async json(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetchImpl(`${this.origin}/api/${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.token}` },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw requestFailure(response.status);
      }
      if (
        response.headers.get('content-type')?.split(';')[0].trim() !==
        'application/json'
      ) {
        await response.body?.cancel().catch(() => {});
        throw new CliError('O serviço retornou uma resposta inválida.');
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new CliError('O serviço retornou uma resposta inválida.');
      const chunks = [];
      let responseBytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        responseBytes += value.byteLength;
        this.received += value.byteLength;
        if (
          responseBytes > MAX_RESPONSE_BYTES ||
          this.received > MAX_RECEIVED_BYTES
        ) {
          await reader.cancel().catch(() => {});
          throw new CliError('A coleta excedeu o limite local de respostas.');
        }
        chunks.push(value);
      }
      try {
        const bytes = Buffer.concat(chunks, responseBytes);
        return JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
      } catch {
        throw new CliError('O serviço retornou uma resposta JSON inválida.');
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (controller.signal.aborted)
        throw new CliError('A coleta excedeu o timeout da requisição.');
      throw new CliError('Não foi possível consultar o serviço.');
    } finally {
      clearTimeout(timer);
    }
  }

  path(suffix, parameters = {}) {
    const query = new URLSearchParams(parameters);
    return `agent/documents/${encodeURIComponent(this.documentId)}/${suffix}${query.size ? `?${query}` : ''}`;
  }

  async page(collection, stamp) {
    const all = [];
    const cursors = new Set();
    let cursor = null;
    do {
      const parameters = { stamp };
      if (cursor !== null) parameters.cursor = cursor;
      const value = await this.json(
        this.path(`feedback/${collection}`, parameters),
      );
      const page = validatePage(value, collection, stamp);
      for (const item of page.items)
        all.push(
          collection === 'comments'
            ? validateComment(item)
            : validateEvent(item),
        );
      if (all.length > MAX_COLLECTION_RECORDS)
        throw new CliError(
          `A coleta excede ${MAX_COLLECTION_RECORDS} ${collection}.`,
        );
      if (page.nextCursor !== null && cursors.has(page.nextCursor))
        throw new CliError('O serviço retornou um cursor repetido ou cíclico.');
      if (page.nextCursor !== null) cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor !== null);
    if (new Set(all.map((item) => item.id)).size !== all.length)
      throw new CliError(`O serviço retornou ${collection} duplicados.`);
    return all;
  }

  async collect() {
    const manifest = validateManifest(
      await this.json(this.path('feedback')),
      this.documentId,
    );
    const comments = await this.page('comments', manifest.stamp);
    const events = await this.page('events', manifest.stamp);
    const revisionIds = [
      manifest.document.current_revision_id,
      ...comments.map((comment) => comment.source_revision_id),
    ].filter((id, index, values) => values.indexOf(id) === index);
    if (revisionIds.length > MAX_SNAPSHOTS)
      throw new CliError('A coleta exige mais de 1000 snapshots.');
    const revisions = [];
    for (const revisionId of revisionIds) {
      const value = await this.json(
        this.path(`revisions/${encodeURIComponent(revisionId)}`, {
          stamp: manifest.stamp,
        }),
      );
      revisions.push(
        validateRevision(value, this.documentId, revisionId, manifest.stamp),
      );
    }
    validateRelationships(manifest, comments, events, revisions);
    const finalManifest = validateManifest(
      await this.json(this.path('feedback', { stamp: manifest.stamp })),
      this.documentId,
    );
    if (!sameJson(finalManifest, manifest))
      throw new CliError('A validação final diverge do manifesto inicial.');
    return { manifest, comments, events, revisions };
  }
}

function revisionFile(id) {
  return `revision-${sha256(Buffer.from(id, 'utf8'))}.md`;
}

function revisionOutput(revision) {
  const markdown = Buffer.from(revision.markdown, 'utf8');
  const { markdown: _markdown, ...metadata } = revision;
  return {
    metadata: {
      ...metadata,
      file: revisionFile(revision.id),
      byte_length: markdown.byteLength,
      sha256: sha256(markdown),
    },
    markdown,
  };
}

export function buildContext(origin, collected, localFile) {
  const revisionFiles = collected.revisions.map(revisionOutput);
  const current = revisionFiles.find(
    (item) =>
      item.metadata.id === collected.manifest.document.current_revision_id,
  );
  if (!current) throw new CliError('A revisão corrente não foi coletada.');
  const status = localFile
    ? localFile.byteLength === current.metadata.byte_length &&
      localFile.sha256 === current.metadata.sha256
      ? 'identical'
      : 'different'
    : 'not_compared';
  return {
    context: {
      schema_version: 1,
      origin,
      export: {
        complete: true,
        validated_at: new Date().toISOString(),
        snapshot_coverage: 'current_and_comment_origins',
        full_revision_history: false,
      },
      semantics: {
        source_start: 'renderer_block_anchor',
        closed_conversation_is_approval: false,
        execution_authorized: false,
        considered_comment_ids: 'author_marked_as_considered',
      },
      document: {
        ...collected.manifest.document,
        counts: collected.manifest.counts,
      },
      comments: collected.comments,
      events: collected.events,
      revisions: revisionFiles.map((item) => item.metadata),
      comparison: {
        status,
        revision_id: current.metadata.id,
        ...(localFile ? { local_file: localFile } : {}),
      },
    },
    revisionFiles,
    comparison: status,
  };
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

async function verifyFile(path, expected, operations) {
  const bytes = await operations.readFile(path);
  if (
    bytes.byteLength !== expected.byteLength ||
    sha256(bytes) !== expected.sha256
  )
    throw new CliError('Um arquivo do bundle divergiu após a escrita.');
}

export async function writeBundle(
  output,
  context,
  revisionFiles,
  operations = defaultOperations,
) {
  let linked = false;
  let serialized = null;
  const temporary = resolve(
    output,
    `.context.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  try {
    for (const item of revisionFiles) {
      const path = resolve(output, item.metadata.file);
      await writeSynced(path, item.markdown, operations);
      await verifyFile(
        path,
        {
          byteLength: item.metadata.byte_length,
          sha256: item.metadata.sha256,
        },
        operations,
      );
    }
    await syncDirectory(output, operations);
    serialized = Buffer.from(`${JSON.stringify(context, null, 2)}\n`, 'utf8');
    await writeSynced(temporary, serialized, operations);
    await verifyFile(
      temporary,
      { byteLength: serialized.byteLength, sha256: sha256(serialized) },
      operations,
    );
    await operations.link(temporary, resolve(output, 'context.json'));
    linked = true;
    await operations.unlink(temporary);
    await syncDirectory(output, operations);
  } catch (error) {
    if (!linked && serialized) {
      try {
        const published = await operations.readFile(
          resolve(output, 'context.json'),
        );
        linked =
          published.byteLength === serialized.byteLength &&
          sha256(published) === sha256(serialized);
      } catch {}
    }
    if (linked)
      throw new CommittedBundleError(
        'context.json foi publicado, mas a confirmação local ficou incerta. Preserve o diretório e verifique-o manualmente.',
      );
    if (error instanceof CliError) throw error;
    throw new CliError(
      'Não foi possível concluir o bundle; o diretório incompleto foi preservado sem context.json.',
    );
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

const defaultOperations = { chmod, link, lstat, mkdir, open, readFile, unlink };

export async function run(argv, environment = process.env) {
  const input = parseArguments(argv);
  if (!input) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const token = validateToken(environment[TOKEN_ENV]);
  const timeout = timeoutFromEnvironment(environment[TIMEOUT_ENV]);
  const localFile = input.file ? await readLocalMarkdown(input.file) : null;
  await reserveOutput(input.output);
  const client = new FeedbackClient({
    origin: input.origin,
    documentId: input.documentId,
    token,
    timeout,
  });
  const collected = await client.collect();
  const built = buildContext(input.origin, collected, localFile);
  await writeBundle(input.output, built.context, built.revisionFiles);
  try {
    await writeStdout({
      origin: input.origin,
      documentId: input.documentId,
      currentRevisionId: collected.manifest.document.current_revision_id,
      output: input.output,
      context: resolve(input.output, 'context.json'),
      comparison: built.comparison,
    });
  } catch {
    throw new CommittedBundleError(
      'context.json foi publicado, mas não foi possível confirmar a saída do comando. Preserve o diretório.',
    );
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
  run(process.argv.slice(2)).catch((error) => {
    const message =
      error instanceof CliError ? error.message : 'Falha inesperada na coleta.';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
