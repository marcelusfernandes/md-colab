'use client';
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { HTMLAttributes } from 'react';
import { EmailLogin } from '@/components/email-login';
import { PublishingTokens } from '@/components/publishing-tokens';
import { api, ApiError, errorText } from '@/lib/client-api';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  analyzeMarkdown,
  classifyMarkdownUrl,
  isNavigableMarkdownUrl,
  warningMessage,
} from '@/lib/markdown-analysis.mjs';
import {
  FileText,
  Upload,
  Share2,
  MessageSquare,
  LockKeyhole,
  ArrowLeft,
  Send,
  X,
  Link as LinkIcon,
  Check,
  LoaderCircle,
  LogOut,
  Mail,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type {
  Viewer,
  DocumentRow,
  CommentRow,
  CommentPagination,
  DocumentSummary,
  ShareRow,
} from '@/lib/document-service';
import {
  collectionAttemptMatches,
  documentPageFromResponse,
  mergeDocumentPages,
  mergeSharePages,
  revokedEmailFromResponse,
  shareMutationFromResponse,
  sharePageFromResponse,
  type CollectionAttempt,
} from '@/lib/collection-page';
import {
  attemptOwnsRequest,
  commentFromResponse,
  createCommentOperation,
  operationAttemptMatches,
  operationMatchesContext,
  operationRequest,
  shouldClearComposer,
  updateCommentOperation,
  type CommentOperation,
} from '@/lib/comment-operation';
import { commentPageFromResponse, mergeComments } from '@/lib/comment-page';
import {
  createImportOperation,
  documentFromImportResponse,
  importAttemptMatches,
  importOperationMatchesSession,
  importOperationRequest,
  importSessionFromResponse,
  updateImportOperation,
  type ImportAttempt,
  type ImportOperation,
} from '@/lib/import-operation';

const COMMENT_REQUEST_TIMEOUT_MS = 30_000;
const IMPORT_REQUEST_TIMEOUT_MS = 30_000;
const COLLECTION_REQUEST_TIMEOUT_MS = 30_000;
function dateLabel(value: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
const block = (tag: string) =>
  function SourceBlock({
    node,
    ...props
  }: HTMLAttributes<HTMLElement> & ExtraProps) {
    return createElement(tag, {
      ...props,
      'data-source-start': node?.position?.start.offset,
    });
  };
function markdownComponents(headingIds: Record<number, string>): Components {
  const components: Components = {
    p: block('p'),
    li: block('li'),
    pre: block('pre'),
    blockquote: block('blockquote'),
  };
  const heading = (tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
    function Heading({
      node,
      ...props
    }: HTMLAttributes<HTMLElement> & ExtraProps) {
      return createElement(tag, {
        ...props,
        id: headingIds[node?.position?.start.offset ?? -1],
        'data-source-start': node?.position?.start.offset,
      });
    };
  components.h1 = heading('h1');
  components.h2 = heading('h2');
  components.h3 = heading('h3');
  components.h4 = heading('h4');
  components.h5 = heading('h5');
  components.h6 = heading('h6');
  components.a = ({ node: _, children, href, ...props }) => {
    const kind = classifyMarkdownUrl(href ?? '');
    if (!isNavigableMarkdownUrl(kind))
      return (
        <span {...props} className="markdown-unavailable-reference">
          {children}
        </span>
      );
    if (kind === 'fragment')
      return (
        <a {...props} href={href}>
          {children}
        </a>
      );
    return (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  };
  components.img = ({ node: _, src, alt, ...props }) => {
    const source = typeof src === 'string' ? src : '';
    const kind = classifyMarkdownUrl(source);
    if (kind !== 'web')
      return (
        <span className="markdown-image-placeholder">
          Imagem não publicada: {alt || source}
        </span>
      );
    return (
      // oxlint-disable-next-line next/no-img-element -- Markdown image sizes and remote origins are user supplied.
      <img
        {...props}
        src={source}
        alt={alt ?? ''}
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    );
  };
  return components;
}

export function DocumentWorkspace({ documentId }: { documentId?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const article = useRef<HTMLElement>(null);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const commentOperationRef = useRef<CommentOperation | null>(null);
  const importOperationRef = useRef<ImportOperation | null>(null);
  const commentValue = useRef('');
  const composerRevision = useRef(0);
  const contextGeneration = useRef(0);
  const activeDocumentId = useRef<string | null>(null);
  const activeViewerId = useRef<string | null>(null);
  const activeViewerIsTest = useRef<boolean | null>(null);
  const collectionSession = useRef<{
    viewerId: string;
    isTest: boolean;
  } | null>(null);
  const commentsRequest = useRef(0);
  const commentsHistoryRequest = useRef(0);
  const commentsRefreshInProgress = useRef(false);
  const commentsHistoryInProgress = useRef(false);
  const commentsNextCursor = useRef<string | null>(null);
  const commentsOlderCursor = useRef<string | null>(null);
  const commentSendRequest = useRef(0);
  const importReadRequest = useRef(0);
  const importReadInProgress = useRef(false);
  const importSendRequest = useRef(0);
  const loadRequest = useRef(0);
  const documentsGeneration = useRef(0);
  const documentsPageRequest = useRef(0);
  const documentsPageInProgress = useRef(false);
  const documentsNextCursor = useRef<string | null>(null);
  const sharesGeneration = useRef(0);
  const sharesReadRequest = useRef(0);
  const sharesReadInProgress = useRef(false);
  const sharesNextCursor = useRef<string | null>(null);
  const sharesMutationRequest = useRef(0);
  const refreshCommentsRef = useRef<(() => Promise<void>) | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [accessMode, setAccessMode] = useState<'email' | 'test'>('email');
  const [authorMode, setAuthorMode] = useState<'allowlist' | 'open'>(
    'allowlist',
  );
  const [canCreate, setCanCreate] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [list, setList] = useState<DocumentSummary[]>([]);
  const [documentsHasMore, setDocumentsHasMore] = useState(false);
  const [documentsLoadingMore, setDocumentsLoadingMore] = useState(false);
  const [documentsPageError, setDocumentsPageError] = useState('');
  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [hasOlderComments, setHasOlderComments] = useState(false);
  const [commentsUpdating, setCommentsUpdating] = useState(false);
  const [commentsLoadingOlder, setCommentsLoadingOlder] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [sharesHasMore, setSharesHasMore] = useState(false);
  const [sharesLoadingMore, setSharesLoadingMore] = useState(false);
  const [sharesPageError, setSharesPageError] = useState('');
  const [personName, setPersonName] = useState('');
  const [personEmail, setPersonEmail] = useState('');
  const [quote, setQuote] = useState('');
  const [sourceStart, setSourceStart] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [commentOperation, setCommentOperation] =
    useState<CommentOperation | null>(null);
  const [importOperation, setImportOperation] =
    useState<ImportOperation | null>(null);
  const [confirmedImport, setConfirmedImport] = useState<Pick<
    DocumentRow,
    'id' | 'filename'
  > | null>(null);
  const [commentsRefreshError, setCommentsRefreshError] = useState('');
  const [commentsHistoryError, setCommentsHistoryError] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [shareError, setShareError] = useState('');
  const [shareNotice, setShareNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const hasUnconfirmedComment =
    Boolean(comment.trim()) || Boolean(commentOperation?.body.trim());
  const hasUnconfirmedWork = hasUnconfirmedComment || Boolean(importOperation);
  const markdownAnalysis = useMemo<ReturnType<typeof analyzeMarkdown>>(
    () =>
      doc ? analyzeMarkdown(doc.markdown) : { headingIds: {}, references: [] },
    [doc],
  );
  const loadedDocumentId = doc?.id;
  const renderedMarkdownComponents = useMemo(
    () =>
      markdownComponents(markdownAnalysis.headingIds as Record<number, string>),
    [markdownAnalysis.headingIds],
  );

  useEffect(() => {
    if (!hasUnconfirmedWork) return;
    function preventUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [hasUnconfirmedWork]);

  const storeCommentOperation = useCallback(
    (operation: CommentOperation | null) => {
      commentOperationRef.current = operation;
      setCommentOperation(operation);
    },
    [],
  );
  const storeImportOperation = useCallback(
    (operation: ImportOperation | null) => {
      importOperationRef.current = operation;
      setImportOperation(operation);
    },
    [],
  );
  const clearCollectionContext = useCallback(() => {
    documentsGeneration.current += 1;
    documentsPageRequest.current += 1;
    documentsPageInProgress.current = false;
    documentsNextCursor.current = null;
    collectionSession.current = null;
    setList([]);
    setDocumentsHasMore(false);
    setDocumentsLoadingMore(false);
    setDocumentsPageError('');
    setConfirmedImport(null);
    setNotice('');
  }, []);
  const clearShareContext = useCallback(() => {
    sharesGeneration.current += 1;
    sharesReadRequest.current += 1;
    sharesMutationRequest.current += 1;
    sharesReadInProgress.current = false;
    sharesNextCursor.current = null;
    setShares([]);
    setSharesLoading(false);
    setSharesHasMore(false);
    setSharesLoadingMore(false);
    setSharesPageError('');
    setShareError('');
    setShareNotice('');
    setBusy((current) =>
      current === 'share' || current.startsWith('revoke:') ? '' : current,
    );
  }, []);
  const blockImportOperation = useCallback(
    (message: string) => {
      const operation = importOperationRef.current;
      if (!operation) return;
      contextGeneration.current += 1;
      importSendRequest.current += 1;
      setBusy((current) => (current === 'import' ? '' : current));
      storeImportOperation(
        updateImportOperation(operation, 'blocked', message),
      );
    },
    [storeImportOperation],
  );
  const confirmCommentOperation = useCallback(
    (operation: CommentOperation, confirmed: CommentRow) => {
      if (commentOperationRef.current?.id !== operation.id) return;
      commentSendRequest.current += 1;
      setBusy((current) =>
        current === 'comment' || current === 'comment-lookup' ? '' : current,
      );
      setComments((current) => mergeComments(current, [confirmed]));
      if (shouldClearComposer(operation, composerRevision.current)) {
        commentValue.current = '';
        setComment('');
        setQuote('');
        setSourceStart(null);
        composerRevision.current += 1;
      }
      commentOperationRef.current = null;
      setCommentOperation(null);
      setNotice('Comentário confirmado.');
    },
    [],
  );
  const hideProtectedContent = useCallback(
    (cause: ApiError) => {
      contextGeneration.current += 1;
      clearShareContext();
      setShareOpen(false);
      commentsRequest.current += 1;
      commentsHistoryRequest.current += 1;
      commentsRefreshInProgress.current = false;
      commentsHistoryInProgress.current = false;
      commentsNextCursor.current = null;
      commentsOlderCursor.current = null;
      commentSendRequest.current += 1;
      setBusy((current) =>
        current === 'comment' || current === 'comment-lookup' ? '' : current,
      );
      activeDocumentId.current = null;
      setDoc(null);
      setIsOwner(false);
      setComments([]);
      setHasOlderComments(false);
      setCommentsUpdating(false);
      setCommentsLoadingOlder(false);
      setQuote('');
      setSourceStart(null);
      setCommentsRefreshError('');
      setCommentsHistoryError('');
      const operation = commentOperationRef.current;
      if (operation) {
        const blocked = updateCommentOperation(
          operation,
          'blocked',
          'O acesso mudou antes da confirmação. Este envio não será reutilizado em outra sessão.',
        );
        commentOperationRef.current = blocked;
        setCommentOperation(blocked);
      }
      setError(
        errorText(cause) +
          (operation || commentValue.current.trim()
            ? ' Sua redação foi preservada nesta página e não será reenviada automaticamente.'
            : ''),
      );
      if (cause.status === 401) {
        activeViewerId.current = null;
        activeViewerIsTest.current = null;
        setNeedsLogin(true);
        setViewer(null);
        setCanCreate(false);
      }
    },
    [clearShareContext],
  );

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    documentsGeneration.current += 1;
    documentsPageRequest.current += 1;
    documentsPageInProgress.current = false;
    setDocumentsLoadingMore(false);
    setDocumentsPageError('');
    clearShareContext();
    setShareOpen(false);
    let sessionRecognized = false;
    try {
      const access = await api<{
        mode: 'email' | 'test';
        authorMode: 'allowlist' | 'open';
      }>('access');
      if (!mounted.current || request !== loadRequest.current) return;
      setAccessMode(access.mode);
      setAuthorMode(access.authorMode);
      const { viewer: user, canCreate: allowed } = await api<{
        viewer: Viewer;
        canCreate: boolean;
      }>('session');
      if (!mounted.current || request !== loadRequest.current) return;
      sessionRecognized = true;
      const userIsTest = Boolean(user.isTest);
      if (
        activeViewerId.current !== null &&
        (activeViewerId.current !== user.id ||
          activeViewerIsTest.current !== userIsTest)
      ) {
        clearCollectionContext();
        clearShareContext();
      }
      const previousOperation = commentOperationRef.current;
      if (previousOperation && previousOperation.viewerId !== user.id) {
        storeCommentOperation(null);
        commentValue.current = '';
        setComment('');
        setQuote('');
        setSourceStart(null);
        composerRevision.current += 1;
        setNotice(
          'A tentativa anterior pertencia a outra sessão e não foi reutilizada.',
        );
      }
      const previousImport = importOperationRef.current;
      if (
        previousImport &&
        !importOperationMatchesSession(previousImport, {
          viewer: user,
          canCreate: allowed,
        })
      )
        blockImportOperation(
          'A identidade, o contexto ou a permissão de criação mudou. Este arquivo não será enviado pela sessão atual.',
        );
      else if (previousImport?.status === 'blocked')
        storeImportOperation(
          updateImportOperation(
            previousImport,
            'uncertain',
            'A mesma sessão foi restaurada. Verifique o resultado antes de reenviar.',
          ),
        );
      activeViewerId.current = user.id;
      activeViewerIsTest.current = userIsTest;
      setViewer(user);
      setCanCreate(allowed);
      setNeedsLogin(false);
      if (documentId) {
        const result = await api<{
          document: DocumentRow;
          comments: CommentRow[];
          pagination: CommentPagination;
          isOwner: boolean;
        }>('documents/' + documentId);
        if (!mounted.current || request !== loadRequest.current) return;
        const currentOperation = commentOperationRef.current;
        if (
          currentOperation &&
          currentOperation.documentId !== result.document.id
        ) {
          storeCommentOperation(null);
          commentValue.current = '';
          setComment('');
          setQuote('');
          setSourceStart(null);
          composerRevision.current += 1;
          setNotice(
            'A tentativa anterior pertencia a outro documento e não foi reutilizada.',
          );
        } else if (currentOperation?.status === 'blocked') {
          storeCommentOperation(
            updateCommentOperation(
              currentOperation,
              'uncertain',
              'O acesso foi restaurado para a mesma sessão. Verifique o resultado antes de reenviar.',
            ),
          );
        }
        contextGeneration.current += 1;
        commentsRequest.current += 1;
        commentsHistoryRequest.current += 1;
        commentsRefreshInProgress.current = false;
        commentsHistoryInProgress.current = false;
        activeDocumentId.current = result.document.id;
        activeViewerId.current = user.id;
        setDoc(result.document);
        const commentPage = commentPageFromResponse(result);
        commentsNextCursor.current = commentPage.pagination.nextCursor;
        commentsOlderCursor.current = commentPage.pagination.olderCursor;
        setComments(commentPage.comments);
        setHasOlderComments(commentPage.pagination.olderCursor !== null);
        setCommentsUpdating(false);
        setCommentsLoadingOlder(false);
        setCommentsRefreshError('');
        setCommentsHistoryError('');
        setIsOwner(result.isOwner);
      } else {
        const page = documentPageFromResponse(
          await api<unknown>('documents', 'GET', undefined, {
            timeoutMs: COLLECTION_REQUEST_TIMEOUT_MS,
          }),
        );
        if (mounted.current && request === loadRequest.current) {
          contextGeneration.current += 1;
          activeDocumentId.current = null;
          setList(page.documents);
          documentsNextCursor.current = page.nextCursor;
          setDocumentsHasMore(page.nextCursor !== null);
          setDocumentsPageError('');
          collectionSession.current = {
            viewerId: user.id,
            isTest: userIsTest,
          };
        }
      }
    } catch (e) {
      if (!mounted.current || request !== loadRequest.current) return;
      if (
        documentId &&
        e instanceof ApiError &&
        [401, 403, 404].includes(e.status)
      ) {
        hideProtectedContent(e);
      } else if (e instanceof ApiError && e.status === 401) {
        contextGeneration.current += 1;
        commentsRequest.current += 1;
        commentsHistoryRequest.current += 1;
        commentsRefreshInProgress.current = false;
        commentsHistoryInProgress.current = false;
        commentsNextCursor.current = null;
        commentsOlderCursor.current = null;
        activeDocumentId.current = null;
        activeViewerId.current = null;
        activeViewerIsTest.current = null;
        setNeedsLogin(true);
        setViewer(null);
        setCanCreate(false);
        clearCollectionContext();
        clearShareContext();
        setDoc(null);
        setComments([]);
        setHasOlderComments(false);
        setCommentsUpdating(false);
        setCommentsLoadingOlder(false);
        blockImportOperation(
          'A sessão terminou. Este arquivo não será enviado por outra identidade.',
        );
      } else {
        contextGeneration.current += 1;
        commentsRequest.current += 1;
        commentsHistoryRequest.current += 1;
        commentsRefreshInProgress.current = false;
        commentsHistoryInProgress.current = false;
        commentsNextCursor.current = null;
        commentsOlderCursor.current = null;
        activeDocumentId.current = null;
        setError(errorText(e));
        setDoc(null);
        setComments([]);
        setHasOlderComments(false);
        setCommentsUpdating(false);
        setCommentsLoadingOlder(false);
        if (!sessionRecognized) {
          activeViewerId.current = null;
          activeViewerIsTest.current = null;
          setViewer(null);
          setCanCreate(false);
          clearCollectionContext();
        }
        const operation = importOperationRef.current;
        if (operation && operation.status !== 'blocked')
          storeImportOperation(
            updateImportOperation(
              operation,
              'uncertain',
              'Não foi possível revalidar a sessão. Verifique antes de reenviar.',
            ),
          );
      }
    } finally {
      if (mounted.current && request === loadRequest.current) setLoading(false);
    }
  }, [
    blockImportOperation,
    clearCollectionContext,
    clearShareContext,
    documentId,
    hideProtectedContent,
    storeCommentOperation,
    storeImportOperation,
  ]);
  useEffect(() => {
    mounted.current = true;
    // oxlint-disable-next-line react/react-compiler -- load updates state after the awaited HTTP request settles.
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  async function loadMoreDocuments() {
    const cursor = documentsNextCursor.current;
    const session = collectionSession.current;
    if (!cursor || !viewer || !session || documentsPageInProgress.current)
      return;
    const context = `${session.viewerId}:${session.isTest ? 'test' : 'email'}`;
    const attempt: CollectionAttempt = {
      generation: documentsGeneration.current,
      request: ++documentsPageRequest.current,
      context,
    };
    documentsPageInProgress.current = true;
    setDocumentsLoadingMore(true);
    setDocumentsPageError('');
    try {
      const parameters = new URLSearchParams({ cursor });
      const page = documentPageFromResponse(
        await api<unknown>(`documents?${parameters}`, 'GET', undefined, {
          timeoutMs: COLLECTION_REQUEST_TIMEOUT_MS,
        }),
      );
      const currentSession = collectionSession.current;
      if (
        !mounted.current ||
        !currentSession ||
        !collectionAttemptMatches(
          attempt,
          documentsGeneration.current,
          documentsPageRequest.current,
          `${currentSession.viewerId}:${currentSession.isTest ? 'test' : 'email'}`,
        ) ||
        activeViewerId.current !== currentSession.viewerId ||
        Boolean(activeViewerIsTest.current) !== currentSession.isTest
      )
        return;
      setList((current) => mergeDocumentPages(current, page.documents));
      documentsNextCursor.current = page.nextCursor;
      setDocumentsHasMore(page.nextCursor !== null);
    } catch (cause) {
      const currentSession = collectionSession.current;
      if (
        !mounted.current ||
        !currentSession ||
        !collectionAttemptMatches(
          attempt,
          documentsGeneration.current,
          documentsPageRequest.current,
          `${currentSession.viewerId}:${currentSession.isTest ? 'test' : 'email'}`,
        )
      )
        return;
      if (cause instanceof ApiError && cause.status === 401) {
        activeViewerId.current = null;
        activeViewerIsTest.current = null;
        setViewer(null);
        setCanCreate(false);
        setNeedsLogin(true);
        clearCollectionContext();
        blockImportOperation(
          'A sessão terminou. Este arquivo não será enviado por outra identidade.',
        );
        setError(errorText(cause));
      } else if (cause instanceof ApiError && cause.status === 400) {
        try {
          const session = importSessionFromResponse(
            await api<unknown>('session', 'GET', undefined, {
              timeoutMs: COLLECTION_REQUEST_TIMEOUT_MS,
            }),
          );
          const latestCollection = collectionSession.current;
          if (
            !latestCollection ||
            !collectionAttemptMatches(
              attempt,
              documentsGeneration.current,
              documentsPageRequest.current,
              `${latestCollection.viewerId}:${latestCollection.isTest ? 'test' : 'email'}`,
            )
          )
            return;
          const sessionIsTest = Boolean(session.viewer.isTest);
          if (
            session.viewer.id !== latestCollection.viewerId ||
            sessionIsTest !== latestCollection.isTest
          ) {
            clearCollectionContext();
            clearShareContext();
            activeViewerId.current = session.viewer.id;
            activeViewerIsTest.current = sessionIsTest;
            setViewer(session.viewer);
            setCanCreate(session.canCreate);
            setNeedsLogin(false);
            blockImportOperation(
              'A identidade ou o contexto mudou. Este arquivo não será enviado pela sessão atual.',
            );
            setLoading(true);
            void load();
          } else {
            setDocumentsPageError(errorText(cause));
          }
        } catch (sessionCause) {
          const latestCollection = collectionSession.current;
          if (
            !latestCollection ||
            !collectionAttemptMatches(
              attempt,
              documentsGeneration.current,
              documentsPageRequest.current,
              `${latestCollection.viewerId}:${latestCollection.isTest ? 'test' : 'email'}`,
            )
          )
            return;
          if (sessionCause instanceof ApiError && sessionCause.status === 401) {
            activeViewerId.current = null;
            activeViewerIsTest.current = null;
            setViewer(null);
            setCanCreate(false);
            setNeedsLogin(true);
            clearCollectionContext();
            blockImportOperation(
              'A sessão terminou. Este arquivo não será enviado por outra identidade.',
            );
            setError(errorText(sessionCause));
          } else {
            setDocumentsPageError(
              `${errorText(cause)} Não foi possível revalidar a sessão: ${errorText(sessionCause)}`,
            );
          }
        }
      } else {
        setDocumentsPageError(errorText(cause));
      }
    } finally {
      if (mounted.current && attempt.request === documentsPageRequest.current) {
        documentsPageInProgress.current = false;
        setDocumentsLoadingMore(false);
      }
    }
  }
  useEffect(() => {
    if (!loadedDocumentId || !window.location.hash) return;
    const frame = window.requestAnimationFrame(() => {
      let id = window.location.hash.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        return;
      }
      document.getElementById(id)?.scrollIntoView();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loadedDocumentId]);
  useEffect(() => {
    if (!doc || !viewer) return;
    let active = true;
    const generation = contextGeneration.current;
    const refresh = async () => {
      if (
        document.visibilityState !== 'visible' ||
        commentsRefreshInProgress.current
      )
        return;
      const initialCursor = commentsNextCursor.current;
      if (!initialCursor) return;
      const request = ++commentsRequest.current;
      commentsRefreshInProgress.current = true;
      setCommentsUpdating(true);
      try {
        let cursor = initialCursor;
        for (;;) {
          const value = await api<unknown>(
            'documents/' +
              doc.id +
              '/comments?after=' +
              encodeURIComponent(cursor),
            'GET',
            undefined,
            { timeoutMs: COMMENT_REQUEST_TIMEOUT_MS },
          );
          if (
            !active ||
            generation !== contextGeneration.current ||
            request !== commentsRequest.current ||
            activeDocumentId.current !== doc.id ||
            activeViewerId.current !== viewer.id
          )
            return;
          const result = commentPageFromResponse(value);
          if (
            result.pagination.olderCursor !== null ||
            (result.pagination.hasMore &&
              result.pagination.nextCursor === cursor)
          )
            throw new Error(
              'O servidor retornou uma continuação de comentários inválida.',
            );
          setComments((current) => mergeComments(current, result.comments));
          commentsNextCursor.current = result.pagination.nextCursor;
          setCommentsRefreshError('');
          const operation = commentOperationRef.current;
          if (
            operation &&
            operationMatchesContext(operation, doc.id, viewer.id)
          ) {
            const found = result.comments.find(
              (entry) => entry.id === operation.id,
            );
            if (found) {
              try {
                confirmCommentOperation(
                  operation,
                  commentFromResponse({ comment: found }, operation),
                );
              } catch (responseError) {
                storeCommentOperation(
                  updateCommentOperation(
                    operation,
                    'error',
                    errorText(responseError),
                  ),
                );
              }
            }
          }
          if (!result.pagination.hasMore) break;
          cursor = result.pagination.nextCursor;
        }
      } catch (e) {
        if (
          !active ||
          generation !== contextGeneration.current ||
          request !== commentsRequest.current
        )
          return;
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          hideProtectedContent(e);
        } else
          setCommentsRefreshError(
            'Não foi possível atualizar os comentários. ' + errorText(e),
          );
      } finally {
        if (
          active &&
          generation === contextGeneration.current &&
          request === commentsRequest.current
        ) {
          commentsRefreshInProgress.current = false;
          setCommentsUpdating(false);
        }
      }
    };
    refreshCommentsRef.current = refresh;
    const timer = window.setInterval(() => void refresh(), 15000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      if (refreshCommentsRef.current === refresh)
        refreshCommentsRef.current = null;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [
    confirmCommentOperation,
    doc,
    hideProtectedContent,
    storeCommentOperation,
    viewer,
  ]);

  const loadOlderComments = useCallback(async () => {
    if (!doc || !viewer || commentsHistoryInProgress.current) return;
    const cursor = commentsOlderCursor.current;
    if (!cursor) return;
    const generation = contextGeneration.current;
    const request = ++commentsHistoryRequest.current;
    commentsHistoryInProgress.current = true;
    setCommentsLoadingOlder(true);
    try {
      const result = commentPageFromResponse(
        await api<unknown>(
          'documents/' +
            doc.id +
            '/comments?before=' +
            encodeURIComponent(cursor),
          'GET',
          undefined,
          { timeoutMs: COMMENT_REQUEST_TIMEOUT_MS },
        ),
      );
      if (
        !mounted.current ||
        generation !== contextGeneration.current ||
        request !== commentsHistoryRequest.current ||
        activeDocumentId.current !== doc.id ||
        activeViewerId.current !== viewer.id
      )
        return;
      if (
        result.pagination.hasMore ||
        result.pagination.olderCursor === cursor ||
        (result.comments.length === 0 && result.pagination.olderCursor !== null)
      )
        throw new Error('O servidor retornou uma página histórica inválida.');
      // Historical pages never replace the independent incremental watermark.
      commentsOlderCursor.current = result.pagination.olderCursor;
      setHasOlderComments(result.pagination.olderCursor !== null);
      setComments((current) => mergeComments(current, result.comments));
      setCommentsHistoryError('');
    } catch (e) {
      if (
        !mounted.current ||
        generation !== contextGeneration.current ||
        request !== commentsHistoryRequest.current
      )
        return;
      if (e instanceof ApiError && [401, 403, 404].includes(e.status))
        hideProtectedContent(e);
      else
        setCommentsHistoryError(
          'Não foi possível carregar os comentários anteriores. ' +
            errorText(e),
        );
    } finally {
      if (
        mounted.current &&
        generation === contextGeneration.current &&
        request === commentsHistoryRequest.current
      ) {
        commentsHistoryInProgress.current = false;
        setCommentsLoadingOlder(false);
      }
    }
  }, [doc, hideProtectedContent, viewer]);

  function importAttemptIsCurrent(
    operation: ImportOperation,
    attempt: ImportAttempt,
  ) {
    return (
      mounted.current &&
      importAttemptMatches(
        operation,
        importOperationRef.current,
        attempt,
        contextGeneration.current,
        importSendRequest.current,
      )
    );
  }
  async function revalidateImportSession(
    operation: ImportOperation,
    attempt: ImportAttempt,
  ) {
    let session: ReturnType<typeof importSessionFromResponse>;
    try {
      session = importSessionFromResponse(
        await api<unknown>('session', 'GET', undefined, {
          timeoutMs: IMPORT_REQUEST_TIMEOUT_MS,
        }),
      );
    } catch (cause) {
      if (importAttemptIsCurrent(operation, attempt)) {
        activeViewerId.current = null;
        activeViewerIsTest.current = null;
        setViewer(null);
        setCanCreate(false);
        clearCollectionContext();
      }
      throw cause;
    }
    if (!importAttemptIsCurrent(operation, attempt)) return false;
    const sessionIsTest = Boolean(session.viewer.isTest);
    if (
      activeViewerId.current !== null &&
      (activeViewerId.current !== session.viewer.id ||
        activeViewerIsTest.current !== sessionIsTest)
    )
      clearCollectionContext();
    activeViewerId.current = session.viewer.id;
    activeViewerIsTest.current = sessionIsTest;
    setViewer(session.viewer);
    setCanCreate(session.canCreate);
    if (!importOperationMatchesSession(operation, session)) {
      blockImportOperation(
        'A identidade, o contexto ou a permissão de criação mudou. Este arquivo não será enviado pela sessão atual.',
      );
      setLoading(true);
      void load();
      return false;
    }
    if (
      collectionSession.current?.viewerId !== session.viewer.id ||
      collectionSession.current.isTest !== sessionIsTest
    ) {
      documentsGeneration.current += 1;
      documentsPageRequest.current += 1;
      documentsPageInProgress.current = false;
      setDocumentsLoadingMore(false);
      try {
        const page = documentPageFromResponse(
          await api<unknown>('documents', 'GET', undefined, {
            timeoutMs: IMPORT_REQUEST_TIMEOUT_MS,
          }),
        );
        if (!importAttemptIsCurrent(operation, attempt)) return false;
        setList(page.documents);
        documentsNextCursor.current = page.nextCursor;
        setDocumentsHasMore(page.nextCursor !== null);
        setDocumentsPageError('');
        collectionSession.current = {
          viewerId: session.viewer.id,
          isTest: sessionIsTest,
        };
      } catch (cause) {
        if (!importAttemptIsCurrent(operation, attempt)) return false;
        blockImportOperation(
          'A sessão foi restaurada, mas a lista de documentos não pôde ser carregada. Tente verificar novamente.',
        );
        setError(
          'Não foi possível carregar os documentos desta sessão. ' +
            errorText(cause),
        );
        return false;
      }
    }
    return true;
  }
  function confirmImportOperation(
    operation: ImportOperation,
    created: DocumentRow,
  ) {
    if (importOperationRef.current?.id !== operation.id) return;
    importSendRequest.current += 1;
    setBusy((current) => (current === 'import' ? '' : current));
    storeImportOperation(null);
    setConfirmedImport({ id: created.id, filename: created.filename });
    const summary: DocumentSummary = {
      id: created.id,
      owner_id: created.owner_id,
      title: created.title,
      filename: created.filename,
      is_test: created.is_test,
      created_at: created.created_at,
      owner_name:
        viewer?.id === operation.viewerId ? viewer.name : operation.viewerId,
      comment_count: 0,
    };
    setList((current) => mergeDocumentPages(current, [summary]));
    setNotice(
      'Importação confirmada. O plano está pronto para abrir.' +
        (documentsNextCursor.current
          ? ' Há mais planos antigos disponíveis para carregar.'
          : ''),
    );
  }
  async function handleImportFailure(
    operation: ImportOperation,
    attempt: ImportAttempt,
    cause: unknown,
  ) {
    if (!importAttemptIsCurrent(operation, attempt)) return;
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
      blockImportOperation(
        'A sessão ou a permissão mudou antes da confirmação. Este arquivo não será enviado pela identidade atual.',
      );
      setLoading(true);
      void load();
      return;
    }
    if (cause instanceof ApiError && cause.status === 409) {
      try {
        if (!(await revalidateImportSession(operation, attempt))) return;
      } catch (sessionError) {
        if (!importAttemptIsCurrent(operation, attempt)) return;
        if (
          sessionError instanceof ApiError &&
          [401, 403].includes(sessionError.status)
        ) {
          blockImportOperation(
            'A sessão mudou antes da confirmação. Este arquivo não será enviado pela identidade atual.',
          );
          return;
        }
        storeImportOperation(
          updateImportOperation(
            operation,
            'uncertain',
            'Não foi possível revalidar a sessão após o conflito. Verifique o resultado antes de reenviar.',
          ),
        );
        return;
      }
    }
    const rejected =
      cause instanceof ApiError && [400, 409].includes(cause.status);
    storeImportOperation(
      updateImportOperation(
        operation,
        rejected ? 'error' : 'uncertain',
        rejected
          ? errorText(cause)
          : errorText(cause) +
              ' O servidor pode ter recebido o arquivo; verifique o resultado ou reenvie a mesma operação.',
      ),
    );
  }
  async function sendImportOperation(operation: ImportOperation) {
    if (
      busy ||
      !importOperationRef.current ||
      importOperationRef.current.id !== operation.id
    )
      return;
    const attempt = {
      generation: contextGeneration.current,
      request: ++importSendRequest.current,
    };
    storeImportOperation(updateImportOperation(operation, 'sending', ''));
    setBusy('import');
    setError('');
    setNotice('');
    try {
      if (!(await revalidateImportSession(operation, attempt))) return;
      const result = await api<unknown>(
        'documents',
        'POST',
        importOperationRequest(operation),
        { timeoutMs: IMPORT_REQUEST_TIMEOUT_MS },
      );
      if (!importAttemptIsCurrent(operation, attempt)) return;
      if (!(await revalidateImportSession(operation, attempt))) return;
      if (!importAttemptIsCurrent(operation, attempt)) return;
      confirmImportOperation(
        operation,
        documentFromImportResponse(result, operation),
      );
    } catch (e) {
      await handleImportFailure(operation, attempt, e);
    } finally {
      if (mounted.current && attempt.request === importSendRequest.current)
        setBusy((current) => (current === 'import' ? '' : current));
    }
  }
  async function verifyImportOperation(operation: ImportOperation) {
    if (
      busy ||
      !importOperationRef.current ||
      importOperationRef.current.id !== operation.id
    )
      return;
    const attempt = {
      generation: contextGeneration.current,
      request: ++importSendRequest.current,
    };
    storeImportOperation(
      updateImportOperation(
        operation,
        'sending',
        'Verificando o plano desta operação…',
      ),
    );
    setBusy('import');
    setError('');
    try {
      if (!(await revalidateImportSession(operation, attempt))) return;
      const result = await api<unknown>(
        'documents/' + operation.id,
        'GET',
        undefined,
        {
          timeoutMs: IMPORT_REQUEST_TIMEOUT_MS,
        },
      );
      if (!importAttemptIsCurrent(operation, attempt)) return;
      if (!(await revalidateImportSession(operation, attempt))) return;
      if (!importAttemptIsCurrent(operation, attempt)) return;
      confirmImportOperation(
        operation,
        documentFromImportResponse(result, operation),
      );
    } catch (e) {
      await handleImportFailure(operation, attempt, e);
    } finally {
      if (mounted.current && attempt.request === importSendRequest.current)
        setBusy((current) => (current === 'import' ? '' : current));
    }
  }
  async function importFile(file?: File) {
    if (
      !file ||
      busy ||
      importReadInProgress.current ||
      importOperationRef.current
    )
      return;
    const request = ++importReadRequest.current;
    importReadInProgress.current = true;
    const generation = contextGeneration.current;
    const selectedViewer = viewer;
    if (input.current) input.current.value = '';
    setConfirmedImport(null);
    setError('');
    setBusy('import');
    try {
      if (!selectedViewer || !canCreate)
        throw new Error('Sua sessão não permite importar documentos.');
      if (!/\.(md|markdown)$/i.test(file.name))
        throw new Error('Escolha um arquivo .md ou .markdown.');
      if (file.size > 1024 * 1024)
        throw new Error('O arquivo deve ter no máximo 1 MB.');
      const markdown = await file.text();
      if (
        !mounted.current ||
        request !== importReadRequest.current ||
        generation !== contextGeneration.current ||
        activeViewerId.current !== selectedViewer.id
      )
        return;
      if (!markdown.trim()) throw new Error('O arquivo está vazio.');
      const operation = createImportOperation({
        viewerId: selectedViewer.id,
        isTest: Boolean(selectedViewer.isTest),
        filename: file.name,
        markdown,
      });
      storeImportOperation(operation);
      await sendImportOperation(operation);
    } catch (e) {
      if (
        mounted.current &&
        request === importReadRequest.current &&
        generation === contextGeneration.current
      )
        setError(errorText(e));
    } finally {
      if (
        mounted.current &&
        request === importReadRequest.current &&
        !importOperationRef.current
      )
        setBusy((current) => (current === 'import' ? '' : current));
      if (request === importReadRequest.current)
        importReadInProgress.current = false;
    }
  }
  const captureSelection = useCallback(() => {
    if (busy === 'comment') return;
    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      !article.current ||
      !article.current.contains(selection.anchorNode) ||
      !article.current.contains(selection.focusNode)
    )
      return;
    const text = selection.toString().trim();
    if (!text) return;
    if (text.length > 4000) {
      setNotice('Selecione um trecho menor para comentar.');
      return;
    }
    const range = selection.getRangeAt(0);
    const element =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    const anchor = element
      ?.closest('[data-source-start]')
      ?.getAttribute('data-source-start');
    setQuote(text);
    setSourceStart(
      anchor === undefined || anchor === null ? null : Number(anchor),
    );
    composerRevision.current += 1;
  }, [busy]);
  useEffect(() => {
    const node = article.current;
    if (!node) return;
    node.addEventListener('pointerup', captureSelection);
    node.addEventListener('keyup', captureSelection);
    return () => {
      node.removeEventListener('pointerup', captureSelection);
      node.removeEventListener('keyup', captureSelection);
    };
  }, [captureSelection, doc]);
  async function verifyCommentOperation(operation: CommentOperation) {
    if (
      busy ||
      !operationMatchesContext(
        operation,
        activeDocumentId.current,
        activeViewerId.current,
      )
    )
      return;
    const attempt = {
      generation: contextGeneration.current,
      request: ++commentSendRequest.current,
    };
    setBusy('comment-lookup');
    setError('');
    setNotice('');
    storeCommentOperation(
      updateCommentOperation(
        operation,
        'uncertain',
        'Verificando esta tentativa no servidor…',
      ),
    );
    try {
      const result = await api<{ comment?: unknown }>(
        'documents/' +
          operation.documentId +
          '/comments/' +
          encodeURIComponent(operation.id),
        'GET',
        undefined,
        { timeoutMs: COMMENT_REQUEST_TIMEOUT_MS },
      );
      if (
        !mounted.current ||
        commentOperationRef.current?.id !== operation.id ||
        !operationAttemptMatches(
          operation,
          activeDocumentId.current,
          activeViewerId.current,
          attempt,
          contextGeneration.current,
          commentSendRequest.current,
        )
      )
        return;
      if (result?.comment === null) {
        storeCommentOperation(
          updateCommentOperation(
            operation,
            'uncertain',
            'A tentativa ainda não foi encontrada. Você pode verificar novamente ou reenviar exatamente o mesmo comentário.',
          ),
        );
        return;
      }
      confirmCommentOperation(
        operation,
        commentFromResponse(result, operation),
      );
    } catch (e) {
      if (
        !mounted.current ||
        commentOperationRef.current?.id !== operation.id ||
        !operationAttemptMatches(
          operation,
          activeDocumentId.current,
          activeViewerId.current,
          attempt,
          contextGeneration.current,
          commentSendRequest.current,
        )
      )
        return;
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        hideProtectedContent(e);
        return;
      }
      storeCommentOperation(
        updateCommentOperation(
          operation,
          'uncertain',
          errorText(e) +
            ' O resultado continua incerto; verifique novamente ou reenvie a mesma tentativa.',
        ),
      );
    } finally {
      if (
        mounted.current &&
        attemptOwnsRequest(attempt, commentSendRequest.current)
      )
        setBusy((current) => (current === 'comment-lookup' ? '' : current));
    }
  }
  async function sendCommentOperation(operation: CommentOperation) {
    if (
      busy ||
      !operationMatchesContext(
        operation,
        activeDocumentId.current,
        activeViewerId.current,
      )
    )
      return;
    const attempt = {
      generation: contextGeneration.current,
      request: ++commentSendRequest.current,
    };
    const sending = updateCommentOperation(operation, 'sending', '');
    storeCommentOperation(sending);
    setBusy('comment');
    setError('');
    setNotice('');
    try {
      const result = await api<unknown>(
        'documents/' + operation.documentId + '/comments',
        'POST',
        operationRequest(operation),
        { timeoutMs: COMMENT_REQUEST_TIMEOUT_MS },
      );
      if (
        !mounted.current ||
        commentOperationRef.current?.id !== operation.id ||
        !operationAttemptMatches(
          operation,
          activeDocumentId.current,
          activeViewerId.current,
          attempt,
          contextGeneration.current,
          commentSendRequest.current,
        )
      )
        return;
      confirmCommentOperation(
        operation,
        commentFromResponse(result, operation),
      );
    } catch (e) {
      if (
        !mounted.current ||
        commentOperationRef.current?.id !== operation.id ||
        !operationAttemptMatches(
          operation,
          activeDocumentId.current,
          activeViewerId.current,
          attempt,
          contextGeneration.current,
          commentSendRequest.current,
        )
      )
        return;
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
        hideProtectedContent(e);
        return;
      }
      const rejected = e instanceof ApiError && [400, 409].includes(e.status);
      storeCommentOperation(
        updateCommentOperation(
          operation,
          rejected ? 'error' : 'uncertain',
          rejected
            ? errorText(e)
            : errorText(e) +
                ' O servidor pode ter recebido o comentário; verifique ou reenvie a mesma tentativa.',
        ),
      );
    } finally {
      if (
        mounted.current &&
        attemptOwnsRequest(attempt, commentSendRequest.current)
      )
        setBusy((current) => (current === 'comment' ? '' : current));
    }
  }
  async function addComment(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!doc || !viewer || !comment.trim() || busy || commentOperation) return;
    const operation = createCommentOperation({
      documentId: doc.id,
      viewerId: viewer.id,
      body: comment,
      quote,
      sourceStart,
      composerRevision: composerRevision.current,
    });
    storeCommentOperation(operation);
    await sendCommentOperation(operation);
  }
  function currentShareContext() {
    return doc && viewer
      ? `${doc.id}:${viewer.id}:${viewer.isTest ? 'test' : 'email'}`
      : '';
  }
  function shareAttemptIsCurrent(
    attempt: CollectionAttempt,
    currentRequest: number,
  ) {
    return (
      mounted.current &&
      isOwner &&
      collectionAttemptMatches(
        attempt,
        sharesGeneration.current,
        currentRequest,
        currentShareContext(),
      )
    );
  }
  function invalidatePendingShareReads() {
    sharesReadRequest.current += 1;
    sharesReadInProgress.current = false;
    setSharesLoading(false);
    setSharesLoadingMore(false);
  }
  function handleKnownShareAccessLoss(cause: unknown) {
    if (!(cause instanceof ApiError) || ![401, 403, 404].includes(cause.status))
      return false;
    setShareOpen(false);
    hideProtectedContent(cause);
    return true;
  }
  async function openSharing() {
    if (!doc || !viewer || !isOwner) return;
    clearShareContext();
    setShareOpen(true);
    setCopied(false);
    setSharesLoading(true);
    sharesReadInProgress.current = true;
    const attempt: CollectionAttempt = {
      generation: sharesGeneration.current,
      request: ++sharesReadRequest.current,
      context: currentShareContext(),
    };
    try {
      const page = sharePageFromResponse(
        await api<unknown>(
          'documents/' + doc.id + '/shares',
          'GET',
          undefined,
          {
            timeoutMs: COLLECTION_REQUEST_TIMEOUT_MS,
          },
        ),
      );
      if (!shareAttemptIsCurrent(attempt, sharesReadRequest.current)) return;
      setShares(page.shares);
      sharesNextCursor.current = page.nextCursor;
      setSharesHasMore(page.nextCursor !== null);
    } catch (cause) {
      if (!shareAttemptIsCurrent(attempt, sharesReadRequest.current)) return;
      if (!handleKnownShareAccessLoss(cause))
        setSharesPageError(errorText(cause));
    } finally {
      if (shareAttemptIsCurrent(attempt, sharesReadRequest.current)) {
        sharesReadInProgress.current = false;
        setSharesLoading(false);
      }
    }
  }
  async function loadMoreShares() {
    const cursor = sharesNextCursor.current;
    if (!cursor || !doc || !viewer || !isOwner || sharesReadInProgress.current)
      return;
    const attempt: CollectionAttempt = {
      generation: sharesGeneration.current,
      request: ++sharesReadRequest.current,
      context: currentShareContext(),
    };
    sharesReadInProgress.current = true;
    setSharesLoadingMore(true);
    setSharesPageError('');
    try {
      const parameters = new URLSearchParams({ cursor });
      const page = sharePageFromResponse(
        await api<unknown>(
          `documents/${doc.id}/shares?${parameters}`,
          'GET',
          undefined,
          { timeoutMs: COLLECTION_REQUEST_TIMEOUT_MS },
        ),
      );
      if (!shareAttemptIsCurrent(attempt, sharesReadRequest.current)) return;
      setShares((current) => mergeSharePages(current, page.shares));
      sharesNextCursor.current = page.nextCursor;
      setSharesHasMore(page.nextCursor !== null);
    } catch (cause) {
      if (!shareAttemptIsCurrent(attempt, sharesReadRequest.current)) return;
      if (!handleKnownShareAccessLoss(cause))
        setSharesPageError(errorText(cause));
    } finally {
      if (shareAttemptIsCurrent(attempt, sharesReadRequest.current)) {
        sharesReadInProgress.current = false;
        setSharesLoadingMore(false);
      }
    }
  }
  async function addPerson(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await sendInvitation(personEmail, personName)) {
      setPersonName('');
      setPersonEmail('');
    }
  }
  async function sendInvitation(email: string, name: string) {
    if (!doc || !viewer || !isOwner || busy) return;
    invalidatePendingShareReads();
    const attempt: CollectionAttempt = {
      generation: sharesGeneration.current,
      request: ++sharesMutationRequest.current,
      context: currentShareContext(),
    };
    setBusy('share');
    setShareError('');
    setShareNotice('');
    try {
      const result = shareMutationFromResponse(
        await api<unknown>(
          'documents/' + doc.id + '/shares',
          'POST',
          { email, name },
          { timeoutMs: COLLECTION_REQUEST_TIMEOUT_MS },
        ),
      );
      if (!shareAttemptIsCurrent(attempt, sharesMutationRequest.current))
        return;
      setShares((current) => mergeSharePages(current, [result.share]));
      if (result.emailSubmitted)
        setShareNotice('Convite enviado para ' + result.share.email + '.');
      else
        setShareError(
          'A pessoa tem acesso, mas o envio do convite não foi confirmado. ' +
            (result.emailError ?? '') +
            ' Use Reenviar convite na lista abaixo.',
        );
      return true;
    } catch (cause) {
      if (!shareAttemptIsCurrent(attempt, sharesMutationRequest.current))
        return;
      if (handleKnownShareAccessLoss(cause)) return;
      setShareError(errorText(cause));
      // Reconcile grants after an uncertain response without resending email.
      if (!(cause instanceof ApiError) || cause.status >= 500)
        try {
          const firstPage = sharePageFromResponse(
            await api<unknown>(
              'documents/' + doc.id + '/shares',
              'GET',
              undefined,
              { timeoutMs: COLLECTION_REQUEST_TIMEOUT_MS },
            ),
          );
          if (shareAttemptIsCurrent(attempt, sharesMutationRequest.current))
            setShares((current) => mergeSharePages(current, firstPage.shares));
        } catch (reconciliationCause) {
          if (shareAttemptIsCurrent(attempt, sharesMutationRequest.current))
            handleKnownShareAccessLoss(reconciliationCause);
          /* Keep the loaded pages and explicit mutation error for manual retry. */
        }
    } finally {
      if (attempt.request === sharesMutationRequest.current)
        setBusy((current) => (current === 'share' ? '' : current));
    }
  }
  async function revoke(email: string) {
    if (!doc || !viewer || !isOwner || busy) return;
    invalidatePendingShareReads();
    const attempt: CollectionAttempt = {
      generation: sharesGeneration.current,
      request: ++sharesMutationRequest.current,
      context: currentShareContext(),
    };
    const busyKey = 'revoke:' + email;
    setBusy(busyKey);
    setShareError('');
    setShareNotice('');
    try {
      const revokedEmail = revokedEmailFromResponse(
        await api<unknown>(
          'documents/' + doc.id + '/shares',
          'DELETE',
          { email },
          { timeoutMs: COLLECTION_REQUEST_TIMEOUT_MS },
        ),
        email,
      );
      if (!shareAttemptIsCurrent(attempt, sharesMutationRequest.current))
        return;
      setShares((current) =>
        current.filter((person) => person.email !== revokedEmail),
      );
    } catch (cause) {
      if (!shareAttemptIsCurrent(attempt, sharesMutationRequest.current))
        return;
      if (!handleKnownShareAccessLoss(cause)) setShareError(errorText(cause));
    } finally {
      if (attempt.request === sharesMutationRequest.current)
        setBusy((current) => (current === busyKey ? '' : current));
    }
  }
  function setSharingOpen(open: boolean) {
    if (open) return;
    clearShareContext();
    setShareOpen(false);
  }
  async function copyLink() {
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(
        window.location.origin + '/d/' + doc.id,
      );
      setCopied(true);
    } catch {
      setShareError('Não foi possível copiar. Copie o endereço da página.');
    }
  }
  function showQuote(entry: CommentRow) {
    if (entry.source_start === null) return;
    const target = article.current?.querySelector(
      '[data-source-start="' + entry.source_start + '"]',
    );
    target?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'center',
    });
    article.current
      ?.querySelectorAll('.comment-anchor')
      .forEach((el) => el.classList.remove('comment-anchor'));
    target?.classList.add('comment-anchor');
  }
  async function signout() {
    if (busy) return;
    setBusy('logout');
    try {
      await api('auth/logout', 'POST', {});
      window.location.assign('/');
    } catch (e) {
      setError(errorText(e));
      setBusy('');
    }
  }
  return (
    <div className="workspace">
      <header className="app-header">
        {/* oxlint-disable-next-line next/no-html-link-for-pages -- Native navigation avoids the unavailable vinext client navigation export. */}
        <a href="/" className="wordmark">
          <FileText size={21} /> Documentos
        </a>
        <div className="header-actions">
          {doc && isOwner && (
            <Button onClick={() => void openSharing()}>
              <Share2 size={16} /> Compartilhar
            </Button>
          )}
          {viewer && (
            <>
              {!viewer.isTest && <PublishingTokens canCreate={canCreate} />}
              <span className="viewer-name">{viewer.name}</span>
              <button
                type="button"
                onClick={() => void signout()}
                disabled={!!busy || !!importOperation}
                aria-label="Sair"
                className="signout"
              >
                <LogOut size={18} />
              </button>
            </>
          )}
        </div>
      </header>
      {accessMode === 'test' && (
        <div className="test-mode-note">
          Modo de teste · E-mails não são verificados. Quem tiver o link pode
          entrar e comentar.
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept=".md,.markdown"
        hidden
        disabled={!!busy || !!importOperation}
        onChange={(e) => void importFile(e.target.files?.[0])}
      />
      {error && (
        <div role="alert" className="error-banner">
          {error}{' '}
          <button
            onClick={() => {
              setError('');
              setLoading(true);
              void load();
            }}
          >
            Tentar novamente
          </button>
        </div>
      )}
      <output aria-live="polite" className="sr-only">
        {notice}
      </output>
      {loading ? (
        <main className="loading-state">
          <LoaderCircle className="spin" size={20} /> Abrindo seus documentos…
        </main>
      ) : needsLogin ? (
        <EmailLogin
          authorMode={authorMode}
          documentId={documentId}
          mode={accessMode}
        />
      ) : !documentId ? (
        <main className="documents-home">
          <div className="page-heading">
            <h1>Seus documentos</h1>
            {canCreate && (
              <Button
                disabled={!!busy || !!importOperation}
                onClick={() => input.current?.click()}
              >
                {busy === 'import' ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Upload size={17} />
                )}{' '}
                {busy === 'import' ? 'Importando…' : 'Importar Markdown'}
              </Button>
            )}
          </div>
          {viewer?.isTest && (
            <p className="test-owner-note">
              Use este navegador e permaneça conectado para administrar os
              documentos que criar neste teste.
            </p>
          )}
          {importOperation && (
            <section
              className={
                'import-operation import-operation-' + importOperation.status
              }
              role={importOperation.status === 'sending' ? 'status' : 'alert'}
              aria-label="Importação pendente"
            >
              <strong>
                {importOperation.status === 'sending'
                  ? importOperation.message || 'Importando Markdown…'
                  : importOperation.status === 'uncertain'
                    ? 'Resultado ainda não confirmado'
                    : importOperation.status === 'blocked'
                      ? 'Retomada bloqueada nesta sessão'
                      : 'A importação precisa da sua atenção'}
              </strong>
              <p className="import-operation-file">
                <FileText size={17} /> {importOperation.filename}
              </p>
              {importOperation.message &&
                importOperation.status !== 'sending' && (
                  <p>{importOperation.message}</p>
                )}
              <p>
                Esta retomada existe somente enquanto esta página permanecer
                aberta. Se fechar ou recarregar, procure o plano na lista antes
                de iniciar outra importação.
              </p>
              {importOperation.status === 'uncertain' && (
                <div className="import-operation-actions">
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void verifyImportOperation(importOperation)}
                  >
                    Verificar resultado
                  </button>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void sendImportOperation(importOperation)}
                  >
                    Reenviar a mesma operação
                  </button>
                </div>
              )}
              {importOperation.status === 'blocked' && (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void verifyImportOperation(importOperation)}
                >
                  Revalidar esta sessão e verificar
                </button>
              )}
              {(importOperation.status === 'blocked' ||
                importOperation.status === 'error') && (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => {
                    importSendRequest.current += 1;
                    storeImportOperation(null);
                    setNotice(
                      'A tentativa de importação foi encerrada nesta página.',
                    );
                  }}
                >
                  Encerrar esta tentativa
                </button>
              )}
            </section>
          )}
          {confirmedImport && (
            <section className="confirmed-import" aria-live="polite">
              <div>
                <strong>Importação confirmada</strong>
                <p>{confirmedImport.filename}</p>
              </div>
              {/* oxlint-disable-next-line next/no-html-link-for-pages -- Native navigation preserves the existing beforeunload protection. */}
              <a href={'/d/' + confirmedImport.id}>Abrir plano</a>
            </section>
          )}
          {list.length === 0 ? (
            <div className="empty-document">
              <FileText size={32} strokeWidth={1.4} />
              <h2>
                {canCreate
                  ? 'Seu primeiro documento começa aqui.'
                  : 'Nenhum documento compartilhado ainda.'}
              </h2>
              <p>
                {canCreate
                  ? 'Importe um Markdown para ler e compartilhar com as pessoas que você escolher.'
                  : 'Os documentos compartilhados com seu e-mail aparecerão aqui.'}
              </p>
              {canCreate && (
                <Button
                  disabled={!!busy || !!importOperation}
                  variant="outline"
                  onClick={() => input.current?.click()}
                >
                  Escolher arquivo .md
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="document-list">
                {list.map((item) => (
                  // oxlint-disable-next-line next/no-html-link-for-pages -- Native navigation avoids the unavailable vinext client navigation export.
                  <a
                    className="document-row"
                    href={'/d/' + item.id}
                    key={item.id}
                  >
                    <FileText size={23} strokeWidth={1.5} />
                    <div className="document-row-title">
                      <h2>{item.title}</h2>
                      <span>
                        {item.owner_id === viewer?.id
                          ? 'Seu documento'
                          : 'Compartilhado por ' + item.owner_name}{' '}
                        · {dateLabel(item.created_at)}
                      </span>
                    </div>
                    <span className="document-row-comments">
                      <MessageSquare size={16} />
                      {item.comment_count}
                    </span>
                  </a>
                ))}
              </div>
              <div className="collection-pagination">
                <p aria-live="polite">
                  {list.length}{' '}
                  {list.length === 1 ? 'plano carregado' : 'planos carregados'}
                  {documentsHasMore ? '. Há planos mais antigos.' : '.'}
                </p>
                {documentsPageError && (
                  <p role="alert" className="form-error">
                    {documentsPageError} Os planos já carregados foram mantidos.
                  </p>
                )}
                {documentsHasMore && (
                  <Button
                    variant="outline"
                    disabled={documentsLoadingMore}
                    onClick={() => void loadMoreDocuments()}
                  >
                    {documentsLoadingMore
                      ? 'Carregando planos…'
                      : documentsPageError
                        ? 'Tentar carregar novamente'
                        : 'Carregar planos mais antigos'}
                  </Button>
                )}
              </div>
            </>
          )}
        </main>
      ) : doc ? (
        <main className="document-page">
          <div className="document-meta">
            {/* oxlint-disable-next-line next/no-html-link-for-pages -- Native navigation avoids the unavailable vinext client navigation export. */}
            <a href="/">
              <ArrowLeft size={16} /> Documentos
            </a>
            <span>
              <LockKeyhole size={14} />{' '}
              {viewer?.isTest
                ? 'Acesso pelo link · Teste'
                : isOwner
                  ? 'Acesso restrito'
                  : 'Pode comentar'}
            </span>
          </div>
          <div className="reading-layout">
            <article ref={article} className="markdown-document">
              {markdownAnalysis.references.length > 0 && (
                <aside
                  className="markdown-reference-warning"
                  aria-label="Referências não publicadas"
                >
                  <strong>
                    Algumas referências não acompanham este Markdown.
                  </strong>
                  <p>
                    Inclua o conteúdo no plano ou use uma URL web explícita.
                  </p>
                  <ul>
                    {markdownAnalysis.references.map((reference) => (
                      <li key={`${reference.offset}-${reference.url}`}>
                        Linha {reference.line}: {warningMessage(reference)}
                      </li>
                    ))}
                  </ul>
                </aside>
              )}
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={renderedMarkdownComponents}
                skipHtml
              >
                {doc.markdown}
              </Markdown>
            </article>
            <aside className="comments-panel" aria-label="Comentários">
              <h2>
                <MessageSquare size={18} /> Comentários{' '}
                <span
                  className="comment-count"
                  aria-label={`${comments.length} comentários carregados`}
                >
                  {comments.length} carregados
                </span>
              </h2>
              {commentsRefreshError && (
                <div className="comments-refresh-error" role="alert">
                  <p>{commentsRefreshError}</p>
                  <button
                    type="button"
                    disabled={!!busy || commentsUpdating}
                    onClick={() => void refreshCommentsRef.current?.()}
                  >
                    Atualizar comentários
                  </button>
                </div>
              )}
              {commentsUpdating && (
                <output className="comments-progress">
                  Buscando novos comentários…
                </output>
              )}
              <form onSubmit={(event) => void addComment(event)}>
                {quote ? (
                  <div className="quote-composer">
                    <blockquote className="selected-quote">{quote}</blockquote>
                    <button
                      type="button"
                      aria-label="Remover trecho selecionado"
                      onClick={() => {
                        setQuote('');
                        setSourceStart(null);
                        composerRevision.current += 1;
                      }}
                    >
                      <X size={15} />
                    </button>
                  </div>
                ) : (
                  <p className="comment-hint">
                    Selecione um trecho ou comente sobre o documento.
                  </p>
                )}
                <label className="sr-only" htmlFor="comment">
                  Seu comentário
                </label>
                <textarea
                  ref={commentInput}
                  id="comment"
                  placeholder="Escreva um comentário…"
                  rows={4}
                  maxLength={5000}
                  value={comment}
                  disabled={busy === 'comment'}
                  onChange={(e) => {
                    commentValue.current = e.target.value;
                    setComment(e.target.value);
                    composerRevision.current += 1;
                  }}
                />
                {commentOperation && (
                  <div
                    className={
                      'comment-operation comment-operation-' +
                      commentOperation.status
                    }
                    role={
                      commentOperation.status === 'sending' ? 'status' : 'alert'
                    }
                  >
                    <strong>
                      {commentOperation.status === 'sending'
                        ? 'Enviando comentário…'
                        : commentOperation.status === 'uncertain'
                          ? 'Resultado ainda não confirmado'
                          : 'O envio precisa da sua atenção'}
                    </strong>
                    {commentOperation.message && (
                      <p>{commentOperation.message}</p>
                    )}
                    {commentOperation.status === 'uncertain' && (
                      <div className="comment-operation-actions">
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() =>
                            void sendCommentOperation(commentOperation)
                          }
                        >
                          Reenviar o mesmo comentário
                        </button>
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() =>
                            void verifyCommentOperation(commentOperation)
                          }
                        >
                          Verificar agora
                        </button>
                      </div>
                    )}
                    {commentOperation.status === 'error' && (
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => {
                          storeCommentOperation(null);
                          setNotice(
                            'A tentativa foi encerrada. Revise a redação antes de enviar novamente.',
                          );
                          commentInput.current?.focus();
                        }}
                      >
                        Revisar e tentar como novo
                      </button>
                    )}
                  </div>
                )}
                <Button
                  disabled={!!busy || !!commentOperation || !comment.trim()}
                  className="comment-submit"
                  type="submit"
                >
                  {busy === 'comment' ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Send size={15} />
                  )}{' '}
                  {busy === 'comment'
                    ? 'Enviando…'
                    : commentOperation
                      ? 'Resolva o envio anterior'
                      : 'Comentar'}
                </Button>
              </form>
              {hasOlderComments && !commentsHistoryError && (
                <div className="comments-pagination">
                  <p>Há comentários anteriores além dos carregados.</p>
                  <button
                    type="button"
                    disabled={!!busy || commentsLoadingOlder}
                    onClick={() => void loadOlderComments()}
                  >
                    {commentsLoadingOlder
                      ? 'Carregando anteriores…'
                      : 'Carregar comentários anteriores'}
                  </button>
                </div>
              )}
              {commentsHistoryError && (
                <div className="comments-refresh-error" role="alert">
                  <p>{commentsHistoryError}</p>
                  <button
                    type="button"
                    disabled={!!busy || commentsLoadingOlder}
                    onClick={() => void loadOlderComments()}
                  >
                    Tentar carregar anteriores novamente
                  </button>
                </div>
              )}
              {comments.length === 0 ? (
                <div className="comments-empty">Nenhum comentário ainda.</div>
              ) : (
                <div className="comments-list">
                  {comments.map((entry) => (
                    <section className="comment-item" key={entry.id}>
                      <div className="comment-author">
                        <span className="avatar">
                          {entry.author_name.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <strong>{entry.author_name}</strong>
                          <time dateTime={entry.created_at}>
                            {dateLabel(entry.created_at)}
                          </time>
                        </div>
                      </div>
                      {entry.quote && (
                        <button
                          type="button"
                          className="comment-quote"
                          onClick={() => showQuote(entry)}
                          aria-label="Ver trecho no documento"
                        >
                          {entry.quote}
                        </button>
                      )}
                      <p>{entry.body}</p>
                    </section>
                  ))}
                </div>
              )}
            </aside>
          </div>
        </main>
      ) : (
        <main className="unavailable-state">
          <LockKeyhole size={28} />
          <h1>Documento indisponível</h1>
          <p>Confira se esta é a conta que recebeu acesso.</p>
          {/* oxlint-disable-next-line next/no-html-link-for-pages -- Native navigation avoids the unavailable vinext client navigation export. */}
          <a href="/">Voltar aos documentos</a>
        </main>
      )}
      {!doc && documentId && (commentOperation || comment.trim()) && (
        <aside className="preserved-comment" aria-label="Redação preservada">
          <h2>Sua redação foi preservada</h2>
          <p>
            Ela permanece somente nesta página. Copie o texto antes de sair; ele
            não será enviado automaticamente depois de entrar novamente.
          </p>
          {commentOperation && (
            <>
              <strong>Envio anterior</strong>
              <blockquote>{commentOperation.body}</blockquote>
            </>
          )}
          {comment.trim() &&
            (!commentOperation || comment.trim() !== commentOperation.body) && (
              <>
                <strong>Redação atual</strong>
                <blockquote>{comment}</blockquote>
              </>
            )}
        </aside>
      )}
      <Dialog open={shareOpen} onOpenChange={setSharingOpen}>
        <DialogContent className="share-dialog">
          <DialogTitle>Compartilhar documento</DialogTitle>
          <DialogDescription>
            {viewer?.isTest
              ? 'Copie o link e envie para quem quiser. A pessoa informa qualquer e-mail para ler e comentar.'
              : 'Cada pessoa receberá um link por e-mail para ler e comentar.'}
          </DialogDescription>
          {shareError && (
            <p role="alert" className="form-error">
              {shareError}
            </p>
          )}
          {shareNotice && (
            <output className="login-message" aria-live="polite">
              {shareNotice}
            </output>
          )}
          {!viewer?.isTest && (
            <>
              <form
                onSubmit={(event) => void addPerson(event)}
                className="share-form"
              >
                <label htmlFor="person-name">Nome (opcional)</label>
                <input
                  id="person-name"
                  placeholder="Nome da pessoa"
                  value={personName}
                  onChange={(e) => setPersonName(e.target.value)}
                  maxLength={120}
                  disabled={
                    sharesLoading || (!!sharesPageError && !shares.length)
                  }
                />
                <label htmlFor="person-email">E-mail</label>
                <input
                  id="person-email"
                  type="email"
                  placeholder="pessoa@empresa.com"
                  value={personEmail}
                  onChange={(e) => setPersonEmail(e.target.value)}
                  required
                  maxLength={254}
                  disabled={
                    sharesLoading || (!!sharesPageError && !shares.length)
                  }
                />
                <Button
                  type="submit"
                  disabled={
                    !!busy ||
                    sharesLoading ||
                    (!!sharesPageError && !shares.length) ||
                    !personEmail.trim()
                  }
                >
                  {busy === 'share' ? 'Enviando…' : 'Enviar convite'}
                </Button>
              </form>
              <div className="access-list">
                <h3>Pessoas com acesso</h3>
                <div className="access-person">
                  <div>
                    <strong>{viewer?.name}</strong>
                    <span>{viewer?.email}</span>
                  </div>
                  <span>Dono</span>
                </div>
                {sharesLoading ? (
                  <p>Carregando…</p>
                ) : (
                  shares.map((person) => (
                    <div className="access-person" key={person.email}>
                      <div>
                        <strong>{person.name}</strong>
                        <span>{person.email}</span>
                      </div>
                      <div className="access-role">
                        <span>Pode comentar</span>
                        <button
                          type="button"
                          disabled={!!busy}
                          aria-label={'Reenviar convite para ' + person.email}
                          title="Reenviar convite"
                          onClick={() =>
                            void sendInvitation(person.email, person.name)
                          }
                        >
                          <Mail size={16} />
                        </button>
                        <button
                          disabled={!!busy}
                          aria-label={'Remover acesso de ' + person.name}
                          onClick={() => void revoke(person.email)}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
                {!sharesLoading && (
                  <div className="collection-pagination access-pagination">
                    <p aria-live="polite">
                      {shares.length}{' '}
                      {shares.length === 1
                        ? 'convidado carregado'
                        : 'convidados carregados'}
                      {sharesHasMore ? '. Há convidados mais antigos.' : '.'}
                    </p>
                    {sharesPageError && (
                      <p role="alert" className="form-error">
                        {sharesPageError} Os convidados já carregados foram
                        mantidos.
                      </p>
                    )}
                    {(sharesHasMore || sharesPageError) && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={sharesLoadingMore || !!busy}
                        onClick={() =>
                          void (sharesHasMore
                            ? loadMoreShares()
                            : openSharing())
                        }
                      >
                        {sharesLoadingMore
                          ? 'Carregando convidados…'
                          : sharesPageError
                            ? 'Tentar carregar novamente'
                            : 'Carregar convidados mais antigos'}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
          <div className="restricted-note">
            <LockKeyhole size={16} />
            <span>
              {viewer?.isTest
                ? 'Modo de teste: qualquer pessoa com o link pode comentar.'
                : 'Acesso restrito às pessoas acima.'}
            </span>
          </div>
          <Button variant="outline" onClick={() => void copyLink()}>
            {copied ? <Check size={16} /> : <LinkIcon size={16} />}{' '}
            {copied ? 'Link copiado' : 'Copiar link'}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
