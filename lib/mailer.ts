import { HttpError } from './document-service.ts';

export type AccessEmail = {
  to: string;
  url: string;
  invitation: boolean;
  id: string;
};
export interface Mailer {
  assertConfigured(): void;
  send(message: AccessEmail): Promise<void>;
}

export class ResendMailer implements Mailer {
  constructor(
    private apiKey: string | undefined,
    private from: string | undefined,
    private transport: typeof fetch = fetch,
  ) {}

  assertConfigured() {
    if (!this.apiKey || !this.from)
      throw new HttpError(503, 'O envio de e-mails ainda não foi configurado.');
  }

  async send(message: AccessEmail) {
    this.assertConfigured();
    const introduction = message.invitation
      ? 'Um documento foi compartilhado com você. Você pode ler e adicionar comentários.'
      : 'Use o link abaixo para acessar seus documentos.';
    // The email contains no document content or user-supplied HTML.
    const response = await this.transport('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + this.apiKey,
        'Content-Type': 'application/json',
        'Idempotency-Key': message.id,
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.invitation
          ? 'Um documento para você comentar'
          : 'Seu link de acesso — Documentos',
        text: `${introduction}\n\n${message.url}\n\nEste link é pessoal, funciona uma vez e expira em 15 minutos. Se expirar, solicite outro na página de entrada.\n\nSe você não esperava este e-mail, pode ignorá-lo.`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new HttpError(
        502,
        'Não foi possível confirmar o envio do e-mail. Tente novamente.',
      );
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== 'string')
      throw new HttpError(
        502,
        'Não foi possível confirmar o envio do e-mail. Tente novamente.',
      );
  }
}
