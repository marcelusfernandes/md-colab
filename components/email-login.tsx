'use client';
import { useEffect, useRef, useState } from 'react';
import { FileText, LockKeyhole, Mail, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, errorText } from '@/lib/client-api';

export function EmailLogin({
  authorMode = 'allowlist',
  documentId,
  mode = 'email',
}: {
  authorMode?: 'allowlist' | 'open';
  documentId?: string;
  mode?: 'email' | 'test';
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'test') {
        const result = await api<{ redirect: string }>('auth/test', 'POST', {
          email,
          documentId,
        });
        window.location.assign(result.redirect);
        return;
      }
      const result = await api<{ message: string }>('auth/request', 'POST', {
        email,
        documentId,
      });
      setMessage(result.message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-state">
      <LockKeyhole size={28} />
      <h1>
        {mode === 'test'
          ? 'Entre para testar.'
          : !documentId && authorMode === 'open'
            ? 'Crie e acesse seus planos com e-mail confirmado.'
            : 'Seus documentos, com acesso restrito.'}
      </h1>
      <p>
        {mode === 'test'
          ? 'Informe qualquer e-mail para identificar seus comentários. A entrada é imediata, sem senha e sem confirmação por e-mail.'
          : documentId
            ? 'Informe o e-mail convidado para este documento. Você receberá um link para entrar, sem senha.'
            : authorMode === 'open'
              ? 'Informe seu e-mail. Depois de confirmar o link, você poderá criar planos privados e acessar os compartilhados com você.'
              : 'Informe seu e-mail para acessar seus planos e os compartilhados com você. Você receberá um link para entrar, sem senha.'}
      </p>
      <form className="login-form" onSubmit={(event) => void submit(event)}>
        <label htmlFor="login-email">Seu e-mail</label>
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="voce@empresa.com"
          required
          maxLength={254}
          value={email}
          disabled={busy}
          onChange={(event) => {
            setEmail(event.target.value);
            setMessage('');
            setError('');
          }}
        />
        <Button type="submit" disabled={busy || !email.trim()}>
          {busy ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <Mail size={17} />
          )}
          {mode === 'test'
            ? busy
              ? 'Entrando…'
              : 'Entrar'
            : busy
              ? 'Solicitando…'
              : message
                ? 'Solicitar outro link'
                : 'Receber link por e-mail'}
        </Button>
        {message && (
          <output className="login-message" aria-live="polite">
            {message}
          </output>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}

export function ConfirmAccess() {
  const token = useRef<string | null>(null);
  const initialized = useRef(false);
  const inFlight = useRef(false);
  const verificationAttempt = useRef(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const attempts = verificationAttempt;
    function receiveToken() {
      attempts.current++;
      token.current = new URLSearchParams(window.location.hash.slice(1)).get(
        'token',
      );
      window.history.replaceState(null, '', '/access');
      if (!inFlight.current) setBusy(false);
      setError('');
      setReady(true);
    }
    if (!initialized.current) {
      initialized.current = true;
      receiveToken();
    }
    window.addEventListener('hashchange', receiveToken);
    return () => {
      attempts.current++;
      window.removeEventListener('hashchange', receiveToken);
    };
  }, []);
  async function confirm() {
    if (inFlight.current) return;
    const currentToken = token.current;
    if (!currentToken) {
      setError('Abra o link recebido por e-mail ou solicite um novo abaixo.');
      return;
    }
    inFlight.current = true;
    const attempt = ++verificationAttempt.current;
    const isCurrentAttempt = () => {
      const nextToken = new URLSearchParams(window.location.hash.slice(1)).get(
        'token',
      );
      return (
        attempt === verificationAttempt.current &&
        (!nextToken || nextToken === currentToken)
      );
    };
    setBusy(true);
    setError('');
    try {
      const result = await api<{ redirect: string }>('auth/verify', 'POST', {
        token: currentToken,
      });
      if (!isCurrentAttempt()) {
        inFlight.current = false;
        setBusy(false);
        return;
      }
      token.current = null;
      window.location.replace(result.redirect);
    } catch (e) {
      if (isCurrentAttempt()) setError(errorText(e));
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="workspace">
      <header className="app-header">
        {/* oxlint-disable-next-line next/no-html-link-for-pages -- Native navigation avoids the unavailable vinext client navigation export. */}
        <a href="/" className="wordmark">
          <FileText size={21} /> Documentos
        </a>
      </header>
      <main className="login-state">
        <Mail size={28} />
        <h1>Abra seus documentos.</h1>
        <p>Confirme abaixo para entrar com o e-mail que recebeu este link.</p>
        <Button disabled={!ready || busy} onClick={() => void confirm()}>
          {busy && <LoaderCircle size={17} className="spin" />}
          {busy ? 'Entrando…' : 'Confirmar acesso'}
        </Button>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {/* oxlint-disable-next-line next/no-html-link-for-pages -- Native navigation avoids the unavailable vinext client navigation export. */}
        <a href="/documentos">Solicitar um novo link por e-mail</a>
      </main>
    </div>
  );
}
