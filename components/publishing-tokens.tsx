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
  created_at: string;
  expires_at: number;
  revoked_at: number | null;
};

function dateLabel(seconds: number) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(seconds * 1000));
}

export function PublishingTokens({ canCreate }: { canCreate: boolean }) {
  const [open, setOpen] = useState(false);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [revoke, setRevoke] = useState<Credential | null>(null);
  const [referenceTime, setReferenceTime] = useState(0);
  const operation = useRef(0);
  const credentialsHeading = useRef<HTMLHeadingElement>(null);
  const revokeConfirmed = useRef(false);

  function changeOpen(next: boolean) {
    operation.current += 1;
    setOpen(next);
    if (next) {
      setBusy('list');
      setError('');
      setReferenceTime(Math.floor(Date.now() / 1000));
    } else {
      revokeConfirmed.current = false;
      setBusy('');
      setSecret('');
      setCopied(false);
      setRevoke(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    const currentOperation = operation.current;
    void api<{ credentials: Credential[] }>('publishing-tokens')
      .then((result) => {
        if (active && operation.current === currentOperation)
          setCredentials(result.credentials);
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
  }, [open]);

  async function create(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy('create');
    setError('');
    setSecret('');
    const currentOperation = ++operation.current;
    try {
      const result = await api<{ token: string; credential: Credential }>(
        'publishing-tokens',
        'POST',
        { name },
      );
      if (operation.current !== currentOperation) return;
      setCredentials((current) => [
        result.credential,
        ...current.filter((item) => item.id !== result.credential.id),
      ]);
      setSecret(result.token);
      setName('');
      setCopied(false);
    } catch (cause) {
      if (operation.current === currentOperation) setError(errorText(cause));
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
      const result = await api<{ credential: Credential }>(
        'publishing-tokens/' + revoke.id,
        'DELETE',
        {},
      );
      if (operation.current !== currentOperation) return;
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
          <DialogTitle>Credenciais de publicação</DialogTitle>
          <DialogDescription>
            Use uma credencial pessoal para publicar Markdown pela API. Cada
            credencial expira em 90 dias.
          </DialogDescription>
          {canCreate ? (
            <form className="publishing-token-form" onSubmit={create}>
              <Label htmlFor="publishing-token-name">Nome da credencial</Label>
              <div>
                <Input
                  id="publishing-token-name"
                  value={name}
                  maxLength={80}
                  placeholder="Ex.: notebook pessoal"
                  disabled={!!busy}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button disabled={!!busy || !name.trim()} type="submit">
                  {busy === 'create' ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Plus size={16} />
                  )}{' '}
                  Gerar
                </Button>
              </div>
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
              Publicações futuras que usarem “{revoke?.name}” serão bloqueadas.
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
