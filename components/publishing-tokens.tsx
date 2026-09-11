'use client';

import { type SyntheticEvent, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  Trash2,
} from 'lucide-react';
import { api, errorText } from '@/lib/client-api';
import { planIdFromTarget } from '@/lib/publishing-token-target';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Credential = {
  id: string;
  name: string;
  scope: 'publish' | 'plan_read' | 'plan_revise';
  document_id: string | null;
  document_title: string | null;
  created_at: string;
  expires_at: number;
  revoked_at: number | null;
};

type Session = { viewer: { id: string } };
type CreatedCredential = {
  viewerId: string;
  token: string;
  credential: Credential;
};

function dateLabel(seconds: number) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(seconds * 1000));
}

export function PublishingTokens({
  canCreate,
  viewerId,
}: {
  canCreate: boolean;
  viewerId: string;
}) {
  const [open, setOpen] = useState(false);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<Credential['scope']>('publish');
  const [documentTarget, setDocumentTarget] = useState('');
  const [secret, setSecret] = useState('');
  const [pendingCreated, setPendingCreated] =
    useState<CreatedCredential | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [revoke, setRevoke] = useState<Credential | null>(null);
  const [referenceTime, setReferenceTime] = useState(0);
  const operation = useRef(0);
  const credentialsHeading = useRef<HTMLHeadingElement>(null);
  const revokeConfirmed = useRef(false);

  useEffect(
    () => () => {
      operation.current += 1;
    },
    [],
  );

  function changeOpen(next: boolean) {
    operation.current += 1;
    setOpen(next);
    if (next) {
      setBusy('list');
      setError('');
      setCredentials([]);
      setPendingCreated(null);
      setReferenceTime(Math.floor(Date.now() / 1000));
    } else {
      revokeConfirmed.current = false;
      setBusy('');
      setSecret('');
      setPendingCreated(null);
      setCopied(false);
      setRevoke(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    const currentOperation = operation.current;
    void api<{ viewerId: string; credentials: Credential[] }>(
      'publishing-tokens',
    )
      .then(async (result) => {
        const session = await api<Session>('session');
        if (
          active &&
          operation.current === currentOperation &&
          result.viewerId === viewerId &&
          session.viewer.id === viewerId
        )
          setCredentials(result.credentials);
        else if (active && operation.current === currentOperation)
          setError('A sessão mudou. Feche e abra novamente para continuar.');
      })
      .catch((cause) => {
        if (active && operation.current === currentOperation)
          setError(errorText(cause));
      })
      .finally(() => {
        if (active && operation.current === currentOperation) setBusy('');
      });
    return () => {
      active = false;
    };
  }, [open, viewerId]);

  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || busy || pendingCreated) return;
    const documentId =
      scope === 'publish'
        ? null
        : planIdFromTarget(documentTarget, window.location.origin);
    if (scope !== 'publish' && !documentId) {
      setError('Informe o ID ou link válido de um plano próprio.');
      return;
    }
    setBusy('create');
    setError('');
    setSecret('');
    setPendingCreated(null);
    const currentOperation = ++operation.current;
    try {
      const before = await api<Session>('session');
      if (
        operation.current !== currentOperation ||
        before.viewer.id !== viewerId
      ) {
        if (operation.current === currentOperation)
          setError('A sessão mudou. Feche e abra novamente para continuar.');
        return;
      }
      const result = await api<CreatedCredential>(
        'publishing-tokens',
        'POST',
        scope === 'publish' ? { name } : { name, scope, documentId },
      );
      if (
        operation.current !== currentOperation ||
        result.viewerId !== viewerId
      ) {
        if (operation.current === currentOperation)
          setError('A sessão mudou. A credencial não será exibida aqui.');
        return;
      }
      setPendingCreated(result);
      try {
        await confirmCreated(result, currentOperation);
      } catch {
        if (operation.current === currentOperation)
          setError(
            'A credencial foi criada, mas não foi possível confirmar a sessão para exibir o segredo. Verifique a sessão sem criar outra.',
          );
      }
    } catch (cause) {
      if (operation.current === currentOperation) setError(errorText(cause));
    } finally {
      if (operation.current === currentOperation) setBusy('');
    }
  }

  async function confirmCreated(
    result: CreatedCredential,
    currentOperation: number,
  ) {
    const session = await api<Session>('session');
    if (operation.current !== currentOperation) return;
    if (result.viewerId !== viewerId || session.viewer.id !== viewerId) {
      setPendingCreated(null);
      setError('A sessão mudou. A credencial não será exibida aqui.');
      return;
    }
    setCredentials((current) => [
      result.credential,
      ...current.filter((item) => item.id !== result.credential.id),
    ]);
    setSecret(result.token);
    setPendingCreated(null);
    setName('');
    setDocumentTarget('');
    setCopied(false);
    setError('');
  }

  async function retryCreated() {
    if (!pendingCreated || busy) return;
    setBusy('verify-create');
    setError('');
    const currentOperation = ++operation.current;
    try {
      await confirmCreated(pendingCreated, currentOperation);
    } catch {
      if (operation.current === currentOperation)
        setError(
          'Ainda não foi possível confirmar a sessão. Tente verificar novamente; nenhuma nova credencial será criada.',
        );
    } finally {
      if (operation.current === currentOperation) setBusy('');
    }
  }

  async function copy() {
    const currentOperation = operation.current;
    const value = secret;
    try {
      await navigator.clipboard.writeText(value);
      if (operation.current === currentOperation) setCopied(true);
    } catch {
      if (operation.current === currentOperation)
        setError(
          'Não foi possível copiar. Selecione a credencial manualmente.',
        );
    }
  }

  async function confirmRevoke() {
    if (!revoke || busy) return;
    revokeConfirmed.current = true;
    setBusy(revoke.id);
    setError('');
    const currentOperation = ++operation.current;
    try {
      const result = await api<{ viewerId: string; credential: Credential }>(
        'publishing-tokens/' + revoke.id,
        'DELETE',
        {},
      );
      const session = await api<Session>('session');
      if (
        operation.current !== currentOperation ||
        result.viewerId !== viewerId ||
        session.viewer.id !== viewerId
      ) {
        if (operation.current === currentOperation) {
          revokeConfirmed.current = false;
          setError('A sessão mudou. Feche e abra novamente para continuar.');
        }
        return;
      }
      setCredentials((current) =>
        current.map((item) =>
          item.id === result.credential.id ? result.credential : item,
        ),
      );
      setRevoke(null);
    } catch (cause) {
      if (operation.current === currentOperation) {
        revokeConfirmed.current = false;
        setError(errorText(cause));
      }
    } finally {
      if (operation.current === currentOperation) setBusy('');
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogTrigger render={<Button variant="outline" size="sm" />}>
          <KeyRound size={16} /> API
        </DialogTrigger>
        <DialogContent className="publishing-token-dialog">
          <DialogTitle>Credenciais de API</DialogTitle>
          <DialogDescription>
            Conceda apenas a finalidade necessária. Cada credencial expira em 90
            dias; podem existir até 10 ativas.
          </DialogDescription>
          {canCreate ? (
            <form className="publishing-token-form" onSubmit={create}>
              <fieldset disabled={!!busy || !!pendingCreated}>
                <legend>Finalidade</legend>
                <label
                  htmlFor="publishing-token-scope-publish"
                  aria-label="Publicação inicial"
                >
                  <input
                    id="publishing-token-scope-publish"
                    type="radio"
                    name="publishing-token-scope"
                    checked={scope === 'publish'}
                    onChange={() => {
                      setScope('publish');
                      setDocumentTarget('');
                      setError('');
                    }}
                  />
                  <span>
                    <strong>Publicação inicial</strong>
                    <small>Cria um novo plano, sem acesso ao feedback.</small>
                  </span>
                </label>
                <label
                  htmlFor="publishing-token-scope-plan-revise"
                  aria-label="Republicação de revisão"
                >
                  <input
                    id="publishing-token-scope-plan-revise"
                    type="radio"
                    name="publishing-token-scope"
                    checked={scope === 'plan_revise'}
                    onChange={() => {
                      setScope('plan_revise');
                      setError('');
                    }}
                  />
                  <span>
                    <strong>Republicação de revisão</strong>
                    <small>
                      Lê o feedback e publica revisões somente de um plano
                      próprio.
                    </small>
                  </span>
                </label>
                <label
                  htmlFor="publishing-token-scope-plan-read"
                  aria-label="Leitura de feedback"
                >
                  <input
                    id="publishing-token-scope-plan-read"
                    type="radio"
                    name="publishing-token-scope"
                    checked={scope === 'plan_read'}
                    onChange={() => {
                      setScope('plan_read');
                      setError('');
                    }}
                  />
                  <span>
                    <strong>Leitura de feedback</strong>
                    <small>Lê somente um plano próprio escolhido.</small>
                  </span>
                </label>
              </fieldset>
              <Label htmlFor="publishing-token-name">Nome da credencial</Label>
              <div className="publishing-token-name-row">
                <Input
                  id="publishing-token-name"
                  value={name}
                  maxLength={80}
                  placeholder="Ex.: agente de revisão"
                  disabled={!!busy || !!pendingCreated}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button
                  disabled={
                    !!busy ||
                    !!pendingCreated ||
                    !name.trim() ||
                    (scope !== 'publish' && !documentTarget.trim())
                  }
                  type="submit"
                >
                  {busy === 'create' ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Plus size={16} />
                  )}{' '}
                  Gerar
                </Button>
              </div>
              {scope !== 'publish' && (
                <div className="publishing-token-target">
                  <Label htmlFor="publishing-token-document">
                    Plano próprio
                  </Label>
                  <Input
                    id="publishing-token-document"
                    value={documentTarget}
                    maxLength={512}
                    placeholder="ID ou https://…/d/ID"
                    disabled={!!busy || !!pendingCreated}
                    onChange={(event) => setDocumentTarget(event.target.value)}
                  />
                  <small>
                    O link apenas seleciona o alvo; o servidor confirma a
                    propriedade antes de conceder acesso.
                  </small>
                </div>
              )}
            </form>
          ) : (
            <p className="publishing-token-note">
              Sua conta não pode gerar novas credenciais. Você ainda pode
              revogar as existentes.
            </p>
          )}
          {secret && (
            <section className="publishing-token-secret" aria-live="polite">
              <strong>Copie agora</strong>
              <p>Por segurança, esta credencial não será exibida novamente.</p>
              <textarea
                readOnly
                rows={3}
                value={secret}
                aria-label="Credencial nova"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void copy()}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}{' '}
                {copied ? 'Copiada' : 'Copiar credencial'}
              </Button>
            </section>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {pendingCreated && (
            <Button
              type="button"
              variant="outline"
              disabled={!!busy}
              onClick={() => void retryCreated()}
            >
              {busy === 'verify-create' && (
                <LoaderCircle className="spin" size={16} />
              )}{' '}
              Verificar sessão e exibir
            </Button>
          )}
          <section
            className="publishing-token-list"
            aria-busy={busy === 'list'}
          >
            <h3 ref={credentialsHeading} tabIndex={-1}>
              Suas credenciais
            </h3>
            {busy === 'list' ? (
              <p>Carregando…</p>
            ) : credentials.length === 0 ? (
              <p>Nenhuma credencial criada.</p>
            ) : (
              credentials.map((credential) => {
                const status = credential.revoked_at
                  ? 'Revogada'
                  : credential.expires_at <= referenceTime
                    ? 'Expirada'
                    : 'Ativa até ' + dateLabel(credential.expires_at);
                return (
                  <div className="publishing-token-row" key={credential.id}>
                    <div>
                      <strong>{credential.name}</strong>
                      <span>
                        {credential.scope === 'publish'
                          ? 'Publicação inicial'
                          : credential.scope === 'plan_read'
                            ? `Feedback · ${credential.document_title ?? 'Plano indisponível'}`
                            : `Republicação · ${credential.document_title ?? 'Plano indisponível'}`}
                      </span>
                      {credential.document_id && (
                        <code>{credential.document_id}</code>
                      )}
                      <span>{status}</span>
                    </div>
                    {!credential.revoked_at && (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={'Revogar ' + credential.name}
                        disabled={!!busy}
                        onClick={() => {
                          revokeConfirmed.current = false;
                          setRevoke(credential);
                        }}
                      >
                        {busy === credential.id ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : (
                          <Trash2 size={16} />
                        )}
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </section>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!revoke}
        onOpenChange={(next) => !next && setRevoke(null)}
      >
        <AlertDialogContent
          className="publishing-token-revoke-dialog"
          finalFocus={() => {
            const confirmed = revokeConfirmed.current;
            revokeConfirmed.current = false;
            return confirmed ? credentialsHeading.current : true;
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Revogar esta credencial?</AlertDialogTitle>
            <AlertDialogDescription>
              {revoke?.scope === 'plan_read'
                ? `Leituras futuras de “${revoke.name}” serão bloqueadas.`
                : revoke?.scope === 'plan_revise'
                  ? `Leituras e republicações futuras de “${revoke.name}” serão bloqueadas.`
                  : `Publicações futuras que usarem “${revoke?.name}” serão bloqueadas.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!!busy}
              onClick={() => void confirmRevoke()}
            >
              Revogar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
