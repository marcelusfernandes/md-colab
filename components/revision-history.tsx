'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  GitCompareArrows,
  History,
  LoaderCircle,
  RefreshCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, ApiError, errorText } from '@/lib/client-api';
import type {
  DocumentRevisionReceipt,
  DocumentRevisionSummary,
  DocumentRow,
  Viewer,
} from '@/lib/document-service';
import { compareRevisionMarkdown } from '@/lib/revision-diff';
import {
  mergeRevisionPages,
  refreshedRevisionPage,
  revisionPageFromResponse,
  revisionReadMatches,
} from '@/lib/revision-history';
import { revisionFromResponse } from '@/lib/revision-operation';

type Props = {
  document: DocumentRow;
  viewer: Viewer;
  revisionId: string | null;
  destinationError: string;
  onNavigate: (revisionId: string | null) => void;
  onOpenComment: (commentId: string) => void;
  onProtectedError: (error: ApiError) => void;
  onReloadCurrent: () => Promise<boolean>;
  onNotice: (message: string) => void;
};

function revisionDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatLabel(value: DocumentRevisionReceipt, side: 'before' | 'after') {
  return `Revisão ${value.ordinal} (${side === 'before' ? 'anterior' : 'posterior'})`;
}

export function RevisionHistory({
  document,
  viewer,
  revisionId,
  destinationError,
  onNavigate,
  onOpenComment,
  onProtectedError,
  onReloadCurrent,
  onNotice,
}: Props) {
  const context = `${document.id}:${viewer.id}:${viewer.isTest ? 'test' : 'email'}`;
  const contextRef = useRef(context);
  const historyRequest = useRef(0);
  const historyInProgress = useRef(false);
  const historyCursor = useRef<string | null>(null);
  const selectionRequest = useRef(0);
  const comparisonRequest = useRef(0);
  const currentReadRequest = useRef(0);
  const [revisions, setRevisions] = useState<DocumentRevisionSummary[]>([]);
  const revisionsRef = useRef<DocumentRevisionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyRefreshing, setHistoryRefreshing] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyFailedKind, setHistoryFailedKind] = useState<
    'initial' | 'refresh' | 'older' | null
  >(null);
  const [historyNotice, setHistoryNotice] = useState('');
  const [selected, setSelected] = useState<DocumentRevisionReceipt | null>(
    null,
  );
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionError, setSelectionError] = useState('');
  const [selectionRetry, setSelectionRetry] = useState(0);
  const [comparisonId, setComparisonId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<DocumentRevisionReceipt | null>(
    null,
  );
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState('');
  const [comparisonRetry, setComparisonRetry] = useState(0);
  const [currentLoading, setCurrentLoading] = useState(false);
  const [currentError, setCurrentError] = useState('');

  const handleReadError = useCallback(
    (cause: unknown, setMessage: (message: string) => void) => {
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
        onProtectedError(cause);
        return;
      }
      setMessage(errorText(cause));
    },
    [onProtectedError],
  );

  const handleSnapshotReadError = useCallback(
    async (
      cause: unknown,
      isCurrent: () => boolean,
      setMessage: (message: string) => void,
    ) => {
      if (!(cause instanceof ApiError) || cause.status !== 404) {
        if (isCurrent()) handleReadError(cause, setMessage);
        return;
      }
      try {
        await api<unknown>(`documents/${document.id}`);
        if (isCurrent())
          setMessage('Esta revisão não está disponível neste plano.');
      } catch (accessCause) {
        if (isCurrent()) handleReadError(accessCause, setMessage);
      }
    },
    [document.id, handleReadError],
  );

  const loadHistory = useCallback(
    async (kind: 'initial' | 'refresh' | 'older') => {
      if (historyInProgress.current) return;
      const cursor = kind === 'older' ? historyCursor.current : null;
      if (kind === 'older' && !cursor) return;
      const request = ++historyRequest.current;
      const attemptContext = context;
      historyInProgress.current = true;
      setHistoryError('');
      setHistoryFailedKind(null);
      if (kind === 'initial') setHistoryLoading(true);
      if (kind === 'older') setHistoryLoadingMore(true);
      if (kind === 'refresh') setHistoryRefreshing(true);
      try {
        const parameters = cursor
          ? `?${new URLSearchParams({ cursor }).toString()}`
          : '';
        const page = revisionPageFromResponse(
          await api<unknown>(`documents/${document.id}/revisions${parameters}`),
          document.id,
        );
        if (
          request !== historyRequest.current ||
          contextRef.current !== attemptContext
        )
          return;
        const previous = revisionsRef.current;
        if (kind === 'older') {
          const merged = mergeRevisionPages(previous, page.revisions);
          revisionsRef.current = merged;
          setRevisions(merged);
          historyCursor.current = page.nextCursor;
          setHistoryHasMore(Boolean(page.nextCursor));
        } else {
          const refreshed = refreshedRevisionPage(
            kind === 'refresh' ? previous : [],
            historyCursor.current,
            page.revisions,
            page.nextCursor,
          );
          revisionsRef.current = refreshed.revisions;
          setRevisions(refreshed.revisions);
          historyCursor.current = refreshed.nextCursor;
          setHistoryHasMore(Boolean(refreshed.nextCursor));
          setHistoryNotice(
            refreshed.reset
              ? 'A janela atual não se sobrepõe ao histórico carregado. A lista foi reiniciada para não ocultar revisões novas; a revisão aberta foi preservada.'
              : kind === 'refresh' && previous.length > 0
                ? 'Histórico atualizado; as revisões já carregadas foram mantidas.'
                : '',
          );
        }
      } catch (cause) {
        if (
          request === historyRequest.current &&
          contextRef.current === attemptContext
        ) {
          if (
            !(cause instanceof ApiError) ||
            ![401, 403, 404].includes(cause.status)
          )
            setHistoryFailedKind(kind);
          handleReadError(cause, setHistoryError);
        }
      } finally {
        if (
          request === historyRequest.current &&
          contextRef.current === attemptContext
        ) {
          historyInProgress.current = false;
          setHistoryLoading(false);
          setHistoryLoadingMore(false);
          setHistoryRefreshing(false);
        }
      }
    },
    [context, document.id, handleReadError],
  );

  useEffect(() => {
    contextRef.current = context;
    historyRequest.current += 1;
    selectionRequest.current += 1;
    comparisonRequest.current += 1;
    currentReadRequest.current += 1;
    historyInProgress.current = false;
    historyCursor.current = null;
    revisionsRef.current = [];
    // oxlint-disable-next-line react/react-compiler -- A protected context change must reset every prior page before the new request starts.
    setRevisions([]);
    setHistoryLoading(true);
    setHistoryLoadingMore(false);
    setHistoryRefreshing(false);
    setHistoryHasMore(false);
    setHistoryError('');
    setHistoryFailedKind(null);
    setHistoryNotice('');
    setSelected(null);
    setSelectionError('');
    setComparisonId(null);
    setComparison(null);
    setComparisonError('');
    setCurrentError('');
    setCurrentLoading(false);
    void loadHistory('initial');
  }, [context, loadHistory]);

  useEffect(
    () => () => {
      contextRef.current = '';
      historyRequest.current += 1;
      selectionRequest.current += 1;
      comparisonRequest.current += 1;
      currentReadRequest.current += 1;
      historyInProgress.current = false;
    },
    [],
  );

  useEffect(() => {
    currentReadRequest.current += 1;
    const request = ++selectionRequest.current;
    const attempt = { request, context, revisionId: revisionId ?? '' };
    // oxlint-disable-next-line react/react-compiler -- URL selection owns a separate snapshot lifecycle and invalidates the previous response synchronously.
    setSelectionError('');
    setSelected(null);
    setComparisonId(null);
    setComparison(null);
    setComparisonError('');
    setCurrentError('');
    setCurrentLoading(false);
    if (!revisionId) {
      setSelected(null);
      setSelectionLoading(false);
      setComparisonId(null);
      return;
    }
    setSelectionLoading(true);
    void (async () => {
      const isCurrent = () =>
        revisionReadMatches(
          attempt,
          selectionRequest.current,
          contextRef.current,
          revisionId,
        );
      try {
        const receipt = revisionFromResponse(
          await api<unknown>(
            `documents/${document.id}/revisions/${revisionId}`,
          ),
        );
        if (!isCurrent()) return;
        if (receipt.document_id !== document.id || receipt.id !== revisionId)
          throw new Error('O servidor retornou outro snapshot de revisão.');
        setSelected(receipt);
        setComparisonId(receipt.base_revision_id);
      } catch (cause) {
        await handleSnapshotReadError(cause, isCurrent, setSelectionError);
      } finally {
        if (isCurrent()) setSelectionLoading(false);
      }
    })();
  }, [
    context,
    document.id,
    handleSnapshotReadError,
    revisionId,
    selectionRetry,
  ]);

  useEffect(() => {
    const request = ++comparisonRequest.current;
    // oxlint-disable-next-line react/react-compiler -- A changed comparison target invalidates the old snapshot before its guarded request starts.
    setComparisonError('');
    setComparison(null);
    if (!selected || !comparisonId) {
      setComparison(null);
      setComparisonLoading(false);
      return;
    }
    if (comparisonId === selected.id) {
      setComparison(selected);
      setComparisonLoading(false);
      return;
    }
    const attempt = { request, context, revisionId: comparisonId };
    setComparisonLoading(true);
    void (async () => {
      const isCurrent = () =>
        revisionReadMatches(
          attempt,
          comparisonRequest.current,
          contextRef.current,
          comparisonId,
        );
      try {
        const receipt = revisionFromResponse(
          await api<unknown>(
            `documents/${document.id}/revisions/${comparisonId}`,
          ),
        );
        if (!isCurrent()) return;
        if (receipt.document_id !== document.id || receipt.id !== comparisonId)
          throw new Error(
            'O servidor retornou outro snapshot para comparação.',
          );
        setComparison(receipt);
      } catch (cause) {
        await handleSnapshotReadError(cause, isCurrent, setComparisonError);
      } finally {
        if (isCurrent()) setComparisonLoading(false);
      }
    })();
  }, [
    comparisonId,
    comparisonRetry,
    context,
    document.id,
    handleSnapshotReadError,
    selected,
  ]);

  const orderedComparison = useMemo(() => {
    if (!selected || !comparison) return null;
    const before =
      selected.ordinal <= comparison.ordinal ? selected : comparison;
    const after =
      selected.ordinal <= comparison.ordinal ? comparison : selected;
    return {
      before,
      after,
      diff: compareRevisionMarkdown(before.markdown, after.markdown),
    };
  }, [comparison, selected]);
  const baseSummary = selected
    ? revisions.find((revision) => revision.id === selected.base_revision_id)
    : undefined;

  async function copyRevisionLink(id: string) {
    const url = new URL(`/d/${document.id}`, window.location.origin);
    url.searchParams.set('revision', id);
    try {
      await navigator.clipboard.writeText(url.toString());
      onNotice('Link desta revisão copiado.');
    } catch {
      onNotice('Não foi possível copiar o link desta revisão.');
    }
  }

  function navigateRevision(id: string | null) {
    currentReadRequest.current += 1;
    setCurrentLoading(false);
    setCurrentError('');
    onNavigate(id);
  }

  function openRevisionComment(id: string) {
    currentReadRequest.current += 1;
    onOpenComment(id);
  }

  async function returnCurrent() {
    if (currentLoading) return;
    const request = ++currentReadRequest.current;
    const attemptContext = context;
    const attemptRevisionId = revisionId;
    const isCurrent = () =>
      revisionReadMatches(
        {
          request,
          context: attemptContext,
          revisionId: attemptRevisionId ?? '',
        },
        currentReadRequest.current,
        contextRef.current,
        revisionId,
      );
    setCurrentLoading(true);
    setCurrentError('');
    try {
      const installed = await onReloadCurrent();
      if (installed && isCurrent()) onNavigate(null);
    } catch (cause) {
      if (isCurrent()) handleReadError(cause, setCurrentError);
    } finally {
      if (isCurrent()) setCurrentLoading(false);
    }
  }

  return (
    <section
      className="revision-history-panel"
      aria-label="Histórico de revisões"
    >
      <div className="revision-history-heading">
        <div>
          <h2>
            <History size={18} /> Histórico de revisões
          </h2>
          <p>
            Snapshots somente leitura. Abrir ou comparar não altera seu rascunho
            nem uma publicação pendente.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={historyLoading || historyLoadingMore || historyRefreshing}
          onClick={() => void loadHistory('refresh')}
        >
          {historyRefreshing ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <RefreshCcw size={15} />
          )}{' '}
          {historyRefreshing ? 'Atualizando…' : 'Atualizar histórico'}
        </Button>
      </div>
      {destinationError && (
        <p role="alert" className="form-error">
          {destinationError}
        </p>
      )}
      {historyNotice && (
        <output className="revision-history-notice">{historyNotice}</output>
      )}
      {historyLoading ? (
        <p>
          <LoaderCircle className="spin" size={16} /> Carregando histórico…
        </p>
      ) : historyError && revisions.length === 0 ? (
        <p role="alert" className="form-error">
          {historyError}{' '}
          <button type="button" onClick={() => void loadHistory('initial')}>
            Tentar novamente
          </button>
        </p>
      ) : (
        <>
          <ol className="revision-history-list">
            {revisions.map((revision) => (
              <li
                key={revision.id}
                className={
                  revisionId === revision.id ? 'revision-history-active' : ''
                }
              >
                <button
                  type="button"
                  aria-current={revisionId === revision.id ? 'true' : undefined}
                  onClick={() => navigateRevision(revision.id)}
                >
                  <strong>
                    Revisão {revision.ordinal}
                    {revision.id === document.current_revision_id
                      ? ' · atual'
                      : ''}
                  </strong>
                  <span>
                    {revision.title} · {revision.author_name}
                  </span>
                  <time dateTime={revision.created_at}>
                    {revisionDate(revision.created_at)}
                  </time>
                </button>
              </li>
            ))}
          </ol>
          {historyHasMore && (
            <Button
              variant="outline"
              disabled={historyLoadingMore}
              onClick={() => void loadHistory('older')}
            >
              {historyLoadingMore ? (
                <LoaderCircle className="spin" size={15} />
              ) : null}
              {historyLoadingMore
                ? 'Carregando…'
                : 'Carregar revisões anteriores'}
            </Button>
          )}
          {historyError && (
            <p role="alert" className="form-error">
              {historyError} As revisões já carregadas foram mantidas.{' '}
              {historyFailedKind && historyFailedKind !== 'initial' && (
                <button
                  type="button"
                  onClick={() => void loadHistory(historyFailedKind)}
                >
                  {historyFailedKind === 'refresh'
                    ? 'Tentar atualizar novamente'
                    : 'Tentar carregar novamente'}
                </button>
              )}
            </p>
          )}
        </>
      )}

      {(revisionId || selectionError) && (
        <div className="revision-snapshot">
          <div className="revision-snapshot-heading">
            <div>
              <strong>
                {selected
                  ? `Revisão visualizada: ${selected.ordinal}`
                  : 'Revisão histórica'}
              </strong>
              <p>
                A revisão atual protegida continua sendo{' '}
                {document.revision_ordinal}.
              </p>
            </div>
            <div className="revision-snapshot-actions">
              {selected && (
                <button
                  type="button"
                  onClick={() => void copyRevisionLink(selected.id)}
                >
                  <Copy size={14} /> Copiar link
                </button>
              )}
              <button
                type="button"
                disabled={currentLoading}
                onClick={() => void returnCurrent()}
              >
                {currentLoading
                  ? 'Relendo revisão atual…'
                  : 'Voltar à revisão atual'}
              </button>
            </div>
          </div>
          {currentError && (
            <p role="alert" className="form-error">
              {currentError}{' '}
              <button type="button" onClick={() => void returnCurrent()}>
                Tentar novamente
              </button>
            </p>
          )}
          {selectionLoading && (
            <p>
              <LoaderCircle className="spin" size={16} /> Carregando snapshot
              exato…
            </p>
          )}
          {selectionError && (
            <p role="alert" className="form-error">
              {selectionError}{' '}
              {revisionId && (
                <button
                  type="button"
                  onClick={() => setSelectionRetry((value) => value + 1)}
                >
                  Tentar novamente
                </button>
              )}
            </p>
          )}
          {selected && (
            <>
              <dl className="revision-snapshot-meta">
                <div>
                  <dt>Arquivo</dt>
                  <dd>{selected.filename}</dd>
                </div>
                <div>
                  <dt>Publicada</dt>
                  <dd>{revisionDate(selected.created_at)}</dd>
                </div>
                <div>
                  <dt>Base explícita</dt>
                  <dd>
                    {selected.base_revision_id
                      ? `${baseSummary ? `Revisão ${baseSummary.ordinal} · ` : 'Snapshot '}${selected.base_revision_id}`
                      : 'Importação inicial'}
                  </dd>
                </div>
                <div>
                  <dt>Resumo</dt>
                  <dd>{selected.summary || 'Sem resumo declarado.'}</dd>
                </div>
              </dl>
              <pre className="revision-original">
                <code>{selected.markdown}</code>
              </pre>
              {selected.considered_comments.length > 0 && (
                <div className="revision-considered-comments">
                  <strong>Contribuições consideradas</strong>
                  <ul>
                    {selected.considered_comments.map((entry) => (
                      <li key={entry.id}>
                        <strong>{entry.author_name}</strong>:{' '}
                        {entry.quote || entry.body}{' '}
                        <button
                          type="button"
                          onClick={() => openRevisionComment(entry.id)}
                        >
                          Abrir conversa
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="revision-comparison">
                <h3>
                  <GitCompareArrows size={17} /> Comparar snapshots
                </h3>
                <label>
                  Comparar com
                  <select
                    value={comparisonId ?? ''}
                    onChange={(event) =>
                      setComparisonId(event.target.value || null)
                    }
                  >
                    <option value="">Escolha uma revisão</option>
                    {!revisions.some(
                      (entry) => entry.id === selected.base_revision_id,
                    ) &&
                      selected.base_revision_id && (
                        <option value={selected.base_revision_id}>
                          Base explícita
                        </option>
                      )}
                    {revisions
                      .filter((entry) => entry.id !== selected.id)
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          Revisão {entry.ordinal} · {entry.title}
                        </option>
                      ))}
                  </select>
                </label>
                {comparisonLoading && (
                  <p>
                    <LoaderCircle className="spin" size={16} /> Carregando
                    comparação…
                  </p>
                )}
                {comparisonError && (
                  <p role="alert" className="form-error">
                    {comparisonError}{' '}
                    <button
                      type="button"
                      onClick={() => setComparisonRetry((value) => value + 1)}
                    >
                      Tentar novamente
                    </button>
                  </p>
                )}
                {orderedComparison && (
                  <div className="revision-diff">
                    <p>
                      <strong>
                        {formatLabel(orderedComparison.before, 'before')}
                      </strong>{' '}
                      →{' '}
                      <strong>
                        {formatLabel(orderedComparison.after, 'after')}
                      </strong>
                    </p>
                    {(orderedComparison.before.title !==
                      orderedComparison.after.title ||
                      orderedComparison.before.filename !==
                        orderedComparison.after.filename) && (
                      <dl className="revision-comparison-meta">
                        {orderedComparison.before.title !==
                          orderedComparison.after.title && (
                          <div>
                            <dt>Título</dt>
                            <dd>
                              {orderedComparison.before.title} →{' '}
                              {orderedComparison.after.title}
                            </dd>
                          </div>
                        )}
                        {orderedComparison.before.filename !==
                          orderedComparison.after.filename && (
                          <div>
                            <dt>Arquivo</dt>
                            <dd>
                              {orderedComparison.before.filename} →{' '}
                              {orderedComparison.after.filename}
                            </dd>
                          </div>
                        )}
                      </dl>
                    )}
                    {(orderedComparison.diff.bomChanged ||
                      orderedComparison.diff.lineEndingsChanged) && (
                      <p className="revision-format-note">
                        Formato de texto alterado: BOM{' '}
                        {orderedComparison.diff.before.bom
                          ? 'presente'
                          : 'ausente'}{' '}
                        →{' '}
                        {orderedComparison.diff.after.bom
                          ? 'presente'
                          : 'ausente'}
                        ; terminações{' '}
                        {orderedComparison.diff.before.lineEndings} →{' '}
                        {orderedComparison.diff.after.lineEndings}; linha final{' '}
                        {orderedComparison.diff.before.finalNewline
                          ? 'com quebra'
                          : 'sem quebra'}{' '}
                        →{' '}
                        {orderedComparison.diff.after.finalNewline
                          ? 'com quebra'
                          : 'sem quebra'}
                        .
                      </p>
                    )}
                    {!orderedComparison.diff.available ? (
                      <p className="revision-diff-unavailable">
                        {orderedComparison.diff.message}. Use os dois originais
                        abaixo.
                      </p>
                    ) : orderedComparison.diff.identical ? (
                      <p>O conteúdo Markdown é idêntico.</p>
                    ) : orderedComparison.diff.lines.length === 0 ? (
                      <p>
                        O conteúdo das linhas é igual; somente o formato de
                        texto mudou.
                      </p>
                    ) : (
                      <pre
                        className="revision-diff-lines"
                        aria-label="Diferenças por linha"
                      >
                        <code>
                          {orderedComparison.diff.lines.map((line, index) => (
                            <span
                              key={`${index}-${line.kind}`}
                              className={`revision-diff-${line.kind}`}
                            >
                              {line.kind === 'added'
                                ? '+'
                                : line.kind === 'removed'
                                  ? '-'
                                  : ' '}
                              {line.text}
                              {'\n'}
                            </span>
                          ))}
                        </code>
                      </pre>
                    )}
                    <details>
                      <summary>
                        Original da revisão {orderedComparison.before.ordinal}
                      </summary>
                      <pre className="revision-original">
                        <code>{orderedComparison.before.markdown}</code>
                      </pre>
                    </details>
                    <details>
                      <summary>
                        Original da revisão {orderedComparison.after.ordinal}
                      </summary>
                      <pre className="revision-original">
                        <code>{orderedComparison.after.markdown}</code>
                      </pre>
                    </details>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
