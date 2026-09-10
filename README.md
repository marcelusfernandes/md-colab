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
npx wrangler d1 execute DB --local --file drizzle/0003_pink_blazing_skull.sql --config wrangler.local.json
npm run dev
```

Aplique cada migração uma única vez no banco local. Preencha `.env.local` com a
origem exata do servidor e a lista de autores (ou o e-mail legado do dono). A
chave deve permanecer nesse arquivo ignorado pelo Git; não a coloque no código
ou em mensagens.

## Acesso por e-mail

- `APP_ORIGIN`: origem canônica, sem caminho. HTTPS na hospedagem;
  HTTP permitido apenas em localhost ou 127.0.0.1.
- `APP_AUTHOR_EMAILS`: lista de e-mails autorizados a importar documentos,
  separados por vírgula. Espaços e maiúsculas são normalizados e repetições são
  ignoradas.
- `APP_OWNER_EMAIL`: configuração legada opcional. O e-mail continua autorizado
  a importar documentos mesmo quando não aparece em `APP_AUTHOR_EMAILS`.
- `APP_OWNER_NAME`: nome exibido nos comentários do dono legado, opcional.
- `RESEND_API_KEY`: chave do serviço de envio.
- `MAIL_FROM`: endereço remetente em domínio verificado no serviço.

O adaptador usa a [API oficial do Resend](https://resend.com/docs/api-reference/emails/send-email).
Para enviar a convidados, configure um remetente autorizado no serviço. As
variáveis da hospedagem são independentes de `.env.local` e precisam ser
configuradas como valores de execução; a chave deve ser um segredo.

Na página inicial, um autor habilitado solicita seu primeiro link sem convite
prévio. A confirmação cria sua conta; logins seguintes recuperam a mesma identidade
e os planos que possui. Ao compartilhar, o convidado recebe seu próprio link; não
precisa definir senha nem ter ChatGPT.
O link expira em 15 minutos e funciona uma vez. Uma confirmação na página evita
que uma simples prévia de link feita pelo serviço de e-mail o consuma.
Links vencidos podem ser solicitados de novo na entrada ou reenviados pelo dono.

Os tokens têm 256 bits aleatórios; só hashes são armazenados no banco. A sessão
fica em cookie HttpOnly, SameSite=Lax e Secure em HTTPS, com validade de sete dias.
As permissões por documento são verificadas no servidor a cada leitura ou escrita.
Remover um convidado invalida convites antigos e bloqueia leitura e comentários,
mesmo com uma sessão aberta; comentários anteriores são preservados.

## Publicação por API

Uma pessoa autenticada por e-mail e atualmente habilitada como autora pode abrir
**API** no cabeçalho, dar um nome à credencial e copiá-la. O segredo começa com
`mdp_`, contém 256 bits aleatórios e aparece somente nessa criação. O banco guarda
apenas seu hash. Cada credencial expira 90 dias depois da emissão; podem existir
até 10 credenciais ativas por pessoa, com nomes de até 80 caracteres. A listagem
mostra somente metadados da própria conta. A pessoa pode revogar suas credenciais
mesmo se deixar de estar habilitada para criar planos. A emissão aceita até 20
tentativas por pessoa a cada 24 horas.

A gestão usa o cookie da sessão verificada:

- `GET /api/publishing-tokens` lista as credenciais próprias sem segredo ou hash;
- `POST /api/publishing-tokens` recebe `{ "name": "Notebook pessoal" }` e
  retorna `{ "token", "credential" }`, com o segredo somente nessa resposta;
- `DELETE /api/publishing-tokens/:id` revoga uma credencial própria.

O segredo autentica exclusivamente `POST /api/publications`. Ele não substitui
o cookie na gestão de credenciais, leitura, comentários ou compartilhamento. A
publicação também confere novamente a lista atual de autores e fica indisponível
em `ACCESS_MODE=test`. Credenciais expiradas ou revogadas são recusadas.

A requisição aceita JSON com `markdown`, `filename` e `title` opcional. O Markdown
continua limitado a 1 MB e é preservado como recebido. `Idempotency-Key` é
obrigatório, aceita de 1 a 128 caracteres ASCII visíveis e fica isolado por autor.
Repetir a mesma chave e o mesmo conteúdo retorna os mesmos identificadores e URL;
usar a chave com conteúdo diferente retorna `409` sem alterar o documento. A
operação cria somente um documento e seu registro de publicação: não importa
arquivos referenciados pelo Markdown, não envia convites e não atualiza planos.

Exemplo com o arquivo escolhido explicitamente:

```sh
PLAN_FILE=./plano.md
PUBLISHING_TOKEN='mdp_substitua_pela_credencial_copiada'
jq -n --rawfile markdown "$PLAN_FILE" --arg filename "$(basename "$PLAN_FILE")" \
  '{markdown: $markdown, filename: $filename}' |
  curl --fail-with-body https://seu-dominio.example/api/publications \
    --request POST \
    --header 'Content-Type: application/json' \
    --header "Authorization: Bearer $PUBLISHING_TOKEN" \
    --header 'Idempotency-Key: exemplo-plano-001' \
    --data-binary @-
```

Uma resposta criada ou repetida mantém este formato:

```json
{
  "documentId": "26e0cb70-9a3e-49d7-9ac0-5a11f4ca46e3",
  "publicationId": "94071e70-ef49-4c17-b7d0-825257271261",
  "url": "https://seu-dominio.example/d/26e0cb70-9a3e-49d7-9ac0-5a11f4ca46e3"
}
```

A habilitação para criar é conferida no servidor em cada importação. Remover um
e-mail da configuração de autores — incluindo `APP_OWNER_EMAIL`, se usado —
bloqueia novas importações, inclusive em sessões já abertas, sem retirar a
propriedade ou os convites que a conta já possui. A lista pode ficar vazia durante
essa revogação sem indisponibilizar o acesso existente. Um link para um documento
específico nunca concede acesso apenas porque o e-mail está na lista de autores:
posse ou convite para aquele documento continuam obrigatórios.

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
