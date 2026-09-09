# Markdown compartilhado

Importe um Markdown, compartilhe com e-mails específicos e receba comentários.
O dono importa e compartilha o link; quem recebe pode ler e comentar.

## Modo de teste atual

Com `ACCESS_MODE=test`, qualquer pessoa com o link informa um e-mail e entra
imediatamente. O e-mail é apenas uma identificação declarada, não é verificado.
Não há envio de mensagens, senha, configuração de Gmail ou conta do Resend nessa
etapa. O botão Compartilhar copia o link do documento.

O dono é identificado pela sessão do navegador que criou o documento. Informar
o mesmo e-mail em outro navegador não recupera essa sessão nem permite administrar
os documentos de outra pessoa. Permaneça conectado no mesmo navegador durante
o teste. A sessão dura sete dias; sair ou limpar os cookies encerra esse acesso.

Documentos criados no teste ficam marcados no banco. Documentos privados anteriores
e contas verificadas ficam fora desse modo. Ao voltar para `ACCESS_MODE=email`,
a entrada sem confirmação é desabilitada e as sessões/documentos de teste não
são aceitos no fluxo autenticado. Não há conversão automática entre os modos.

## Executar localmente

Requer Node.js 22.22 ou mais recente e npm.

```sh
npm install
cp .env.example .env.local
npx wrangler d1 execute DB --local --file drizzle/0000_mute_microchip.sql --config wrangler.local.json
npx wrangler d1 execute DB --local --file drizzle/0001_email_access.sql --config wrangler.local.json
npx wrangler d1 execute DB --local --file drizzle/0002_link_test_mode.sql --config wrangler.local.json
npm run dev
```

Aplique cada migração uma única vez no banco local. Preencha `.env.local` com a
origem exata do servidor e o e-mail do dono. A chave deve permanecer nesse arquivo
ignorado pelo Git; não a coloque no código ou em mensagens.

## Acesso por e-mail, para uma etapa posterior

- `APP_ORIGIN`: origem canônica, sem caminho. HTTPS na hospedagem;
  HTTP permitido apenas em localhost ou 127.0.0.1.
- `APP_OWNER_EMAIL`: e-mail autorizado a importar documentos.
- `APP_OWNER_NAME`: nome exibido nos comentários do dono, opcional.
- `RESEND_API_KEY`: chave do serviço de envio.
- `MAIL_FROM`: endereço remetente em domínio verificado no serviço.

O adaptador usa a [API oficial do Resend](https://resend.com/docs/api-reference/emails/send-email).
Para enviar a convidados, configure um remetente autorizado no serviço. As
variáveis da hospedagem são independentes de `.env.local` e precisam ser
configuradas como valores de execução; a chave deve ser um segredo.

Na página inicial, informe o e-mail do dono e solicite um link. Ao compartilhar,
o convidado recebe seu próprio link; não precisa definir senha nem ter ChatGPT.
O link expira em 15 minutos e funciona uma vez. Uma confirmação na página evita
que uma simples prévia de link feita pelo serviço de e-mail o consuma.
Links vencidos podem ser solicitados de novo na entrada ou reenviados pelo dono.

Os tokens têm 256 bits aleatórios; só hashes são armazenados no banco. A sessão
fica em cookie HttpOnly, SameSite=Lax e Secure em HTTPS, com validade de sete dias.
As permissões por documento são verificadas no servidor a cada leitura ou escrita.
Remover um convidado invalida convites antigos e bloqueia leitura e comentários,
mesmo com uma sessão aberta; comentários anteriores são preservados.

Sem serviço de e-mail configurado, o sistema exibe essa pendência e não finge um
envio. Se um convite falhar após a concessão do acesso, o dono vê a situação e pode
reenviar manualmente. A confirmação do provedor significa aceitação do envio;
recebimento na caixa de entrada não é inferido. Na entrada anônima a mensagem é
condicional e idêntica para e-mails conhecidos e desconhecidos, inclusive quando
o provedor falha. Solicitações de links têm limites por e-mail e endereço de rede.

## O que está implementado

- Importação de `.md` e `.markdown` de até 1 MB, preservando o texto original.
- Títulos, subtítulos, negritos, tabelas, listas, links e código renderizados;
  HTML arbitrário é descartado.
- Documentos e comentários persistidos em SQLite/D1.
- Compartilhamento por nome opcional e e-mail, com convite e reenvio.
- Comentários gerais ou em trechos selecionados, com autor e data.
- Atualização de comentários ao voltar à página e a cada 15 segundos.
- Reenvio de comentário com o mesmo identificador sem duplicação.

## Estado da disponibilização

O modo de teste é explicitamente controlado por `ACCESS_MODE=test` e sinalizado
na interface. Não há caixa de e-mails de desenvolvimento acessível pela aplicação.
Os testes automatizados de autenticação usam um transporte isolado.

O modo atual permite testar importação, leitura, compartilhamento de link e
comentários sem serviço de envio. Para retomar convites autenticados por e-mail,
ainda será necessário configurar um remetente e validar a entrega real.

A hospedagem Sites também tem uma política de acesso anterior à aplicação.
Enquanto a hospedagem estiver restrita ao proprietário, convidados externos não
conseguem chegar ao login, mesmo que tenham permissão no documento. Para usar
somente o login por e-mail, a página de entrada precisa ser acessível aos convidados;
no modo de teste, o link e um e-mail declarado bastam para abrir um documento
de teste. No modo de e-mail, permanecem as permissões por convite da API.

## Verificação

```sh
npm run check
npm run lint
npm test
npm run build
```

Os testes usam SQLite com as migrações reais e um transporte de e-mail em memória.
Cobrem importação, convite, autenticação, comentário, restrição de convidados,
revogação, expiração, consumo concorrente do link, logout, limites, rejeição de
identidades forjadas, origem da solicitação e recuperação de falha de envio.

## Organização

- `components/document-workspace.tsx`: importação, leitura, compartilhamento e comentários.
- `components/email-login.tsx`: solicitação de link e confirmação de acesso.
- `lib/document-service.ts`: consultas e permissões por documento.
- `lib/auth-service.ts`: links de acesso, sessões e limites.
- `lib/mailer.ts`: transporte de e-mail.
- `lib/api-handler.ts`: endpoints e autorização de ações.
- `app/api/[...path]/route.ts`: integração da API com o ambiente hospedado.
- `db/schema.ts` e `drizzle/`: schema e migrações.

CLI, MCP, editor, versionamento e funcionalidades de IA ficam para outra etapa.
