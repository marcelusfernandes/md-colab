'use client';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes } from 'react';
import Link from 'next/link';
import { EmailLogin } from '@/components/email-login';
import { api, ApiError, errorText } from '@/lib/client-api';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
  ShareRow,
} from '@/lib/document-service';

type Summary = Omit<DocumentRow, 'markdown'> & {
  owner_name: string;
  comment_count: number;
};
function dateLabel(value: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
function mergeComments(current: CommentRow[], incoming: CommentRow[]) {
  return [
    ...new Map(
      [...current, ...incoming].map((entry) => [entry.id, entry]),
    ).values(),
  ].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
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
const markdownComponents: Components = {
  p: block('p'),
  h1: block('h1'),
  h2: block('h2'),
  h3: block('h3'),
  h4: block('h4'),
  h5: block('h5'),
  h6: block('h6'),
  li: block('li'),
  pre: block('pre'),
  blockquote: block('blockquote'),
};
markdownComponents.a = ({ node: _, children, ...props }) => (
  <a {...props} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);
markdownComponents.img = ({ node: _, ...props }) => (
  // oxlint-disable-next-line next/no-img-element -- Markdown image sizes and remote origins are user supplied.
  <img
    {...props}
    alt={props.alt ?? ''}
    referrerPolicy="no-referrer"
    loading="lazy"
  />
);

export function DocumentWorkspace({ documentId }: { documentId?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const article = useRef<HTMLElement>(null);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const draftId = useRef<string | null>(null);
  const mounted = useRef(true);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [accessMode, setAccessMode] = useState<'email' | 'test'>('email');
  const [canCreate, setCanCreate] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [list, setList] = useState<Summary[]>([]);
  const [doc, setDoc] = useState<DocumentRow | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [personName, setPersonName] = useState('');
  const [personEmail, setPersonEmail] = useState('');
  const [quote, setQuote] = useState('');
  const [sourceStart, setSourceStart] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [shareError, setShareError] = useState('');
  const [shareNotice, setShareNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const access = await api<{ mode: 'email' | 'test' }>('access');
      if (!mounted.current) return;
      setAccessMode(access.mode);
      const { viewer: user, canCreate: allowed } = await api<{
        viewer: Viewer;
        canCreate: boolean;
      }>('session');
      if (!mounted.current) return;
      setViewer(user);
      setCanCreate(allowed);
      setNeedsLogin(false);
      if (documentId) {
        const result = await api<{
          document: DocumentRow;
          comments: CommentRow[];
          isOwner: boolean;
        }>('documents/' + documentId);
        if (!mounted.current) return;
        setDoc(result.document);
        setComments(result.comments);
        setIsOwner(result.isOwner);
      } else {
        const result = await api<{ documents: Summary[] }>('documents');
        if (mounted.current) setList(result.documents);
      }
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof ApiError && e.status === 401) {
        setNeedsLogin(true);
        setViewer(null);
        setCanCreate(false);
      } else setError(errorText(e));
      setDoc(null);
      setComments([]);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [documentId]);
  useEffect(() => {
    mounted.current = true;
    // oxlint-disable-next-line react/react-compiler -- load updates state after the awaited HTTP request settles.
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (!doc) return;
    let active = true;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const result = await api<{ comments: CommentRow[] }>(
          'documents/' + doc.id + '/comments',
        );
        if (active)
          setComments((current) => mergeComments(current, result.comments));
      } catch (e) {
        if (!active) return;
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          setDoc(null);
          setComments([]);
          setQuote('');
          setComment('');
          setError(errorText(e));
          if (e.status === 401) {
            setNeedsLogin(true);
            setViewer(null);
            setCanCreate(false);
          }
        }
      }
    };
    const timer = window.setInterval(() => void refresh(), 15000);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [doc]);

  async function importFile(file?: File) {
    if (!file || busy) return;
    setError('');
    setBusy('import');
    try {
      if (!/\.(md|markdown)$/i.test(file.name))
        throw new Error('Escolha um arquivo .md ou .markdown.');
      if (file.size > 1024 * 1024)
        throw new Error('O arquivo deve ter no máximo 1 MB.');
      const markdown = await file.text();
      if (!markdown.trim()) throw new Error('O arquivo está vazio.');
      const { document: created } = await api<{ document: DocumentRow }>(
        'documents',
        'POST',
        { markdown, filename: file.name },
      );
      window.location.assign('/d/' + created.id);
    } catch (e) {
      setError(errorText(e));
      setBusy('');
    } finally {
      if (input.current) input.current.value = '';
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
    draftId.current = null;
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
  async function addComment(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!doc || !comment.trim() || busy) return;
    setBusy('comment');
    setError('');
    draftId.current ??= crypto.randomUUID();
    try {
      const result = await api<{ comment: CommentRow }>(
        'documents/' + doc.id + '/comments',
        'POST',
        { id: draftId.current, body: comment, quote, sourceStart },
      );
      setComments((current) =>
        current.some((c) => c.id === result.comment.id)
          ? current
          : [...current, result.comment],
      );
      setComment('');
      setQuote('');
      setSourceStart(null);
      draftId.current = null;
      setNotice('Comentário adicionado.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }
  async function openSharing() {
    if (!doc) return;
    setShareOpen(true);
    setShareError('');
    setSharesLoading(true);
    setShareNotice('');
    setCopied(false);
    try {
      setShares(
        (await api<{ shares: ShareRow[] }>('documents/' + doc.id + '/shares'))
          .shares,
      );
    } catch (e) {
      setShareError(errorText(e));
    } finally {
      setSharesLoading(false);
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
    if (!doc || busy) return;
    setBusy('share');
    setShareError('');
    setShareNotice('');
    try {
      const result = await api<{
        shares: ShareRow[];
        emailSubmitted: boolean;
        emailError?: string;
      }>('documents/' + doc.id + '/shares', 'POST', { email, name });
      setShares(result.shares);
      if (result.emailSubmitted)
        setShareNotice('Convite enviado para ' + email.trim() + '.');
      else
        setShareError(
          'A pessoa tem acesso, mas o envio do convite não foi confirmado. ' +
            (result.emailError ?? '') +
            ' Use Reenviar convite na lista abaixo.',
        );
      return true;
    } catch (e) {
      setShareError(errorText(e));
      // Reconcile grants after an uncertain response without resending email.
      try {
        setShares(
          (await api<{ shares: ShareRow[] }>('documents/' + doc.id + '/shares'))
            .shares,
        );
      } catch {
        /* The next dialog opening can refresh the list. */
      }
    } finally {
      setBusy('');
    }
  }
  async function revoke(email: string) {
    if (!doc || busy) return;
    setBusy(email);
    setShareError('');
    setShareNotice('');
    try {
      setShares(
        (
          await api<{ shares: ShareRow[] }>(
            'documents/' + doc.id + '/shares',
            'DELETE',
            { email },
          )
        ).shares,
      );
    } catch (e) {
      setShareError(errorText(e));
    } finally {
      setBusy('');
    }
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
        <Link href="/" className="wordmark">
          <FileText size={21} /> Documentos
        </Link>
        <div className="header-actions">
          {doc && isOwner && (
            <Button onClick={() => void openSharing()}>
              <Share2 size={16} /> Compartilhar
            </Button>
          )}
          {viewer && (
            <>
              <span className="viewer-name">{viewer.name}</span>
              <button
                type="button"
                onClick={() => void signout()}
                disabled={!!busy}
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
        <EmailLogin documentId={documentId} mode={accessMode} />
      ) : !documentId ? (
        <main className="documents-home">
          <div className="page-heading">
            <h1>Seus documentos</h1>
            {canCreate && (
              <Button disabled={!!busy} onClick={() => input.current?.click()}>
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
                  disabled={!!busy}
                  variant="outline"
                  onClick={() => input.current?.click()}
                >
                  Escolher arquivo .md
                </Button>
              )}
            </div>
          ) : (
            <div className="document-list">
              {list.map((item) => (
                <Link
                  prefetch={false}
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
                </Link>
              ))}
            </div>
          )}
        </main>
      ) : doc ? (
        <main className="document-page">
          <div className="document-meta">
            <Link href="/">
              <ArrowLeft size={16} /> Documentos
            </Link>
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
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
                skipHtml
              >
                {doc.markdown}
              </Markdown>
            </article>
            <aside className="comments-panel" aria-label="Comentários">
              <h2>
                <MessageSquare size={18} /> Comentários{' '}
                <span className="comment-count">{comments.length}</span>
              </h2>
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
                        draftId.current = null;
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
                    setComment(e.target.value);
                    draftId.current = null;
                  }}
                />
                <Button
                  disabled={!!busy || !comment.trim()}
                  className="comment-submit"
                  type="submit"
                >
                  {busy === 'comment' ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Send size={15} />
                  )}{' '}
                  {busy === 'comment' ? 'Enviando…' : 'Comentar'}
                </Button>
              </form>
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
          <Link href="/">Voltar aos documentos</Link>
        </main>
      )}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
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
                />
                <Button type="submit" disabled={!!busy || !personEmail.trim()}>
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
