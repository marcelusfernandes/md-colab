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

Para reproduzir a validação, use Node.js 22.22.3 e npm 10.9.8. O mínimo técnico
declarado em `package.json` é Node 22.13.0; a versão exercitada neste procedimento
e na CI é 22.22.3. Wrangler 4.92.0 vem do lockfile.

```sh
npm ci
cp .env.example .env.local
npm run db:status:local -- --persist-to .wrangler/state
npm run db:migrate:local -- --persist-to .wrangler/state
npm run dev
```

O Wrangler aplica `drizzle/0000..0003` na ordem e registra o ledger no banco;
repetir o comando não reaplica DDL. Use sempre um `--persist-to` explícito e não
reutilize a persistência de outra sessão. Se `status` encontrar schema sem ledger,
`migrate` recusa a escrita: siga o [runbook de D1](docs/d1-recovery.md) para
diagnosticar um legado conhecido, fazer backup e adotar o histórico de forma
explícita. Não execute novamente os SQLs históricos à mão.

Preencha `.env.local` com a origem exata do servidor e a lista de autores (ou o
e-mail legado do dono). A chave deve permanecer nesse arquivo ignorado pelo Git;
não a coloque no código ou em mensagens.

`npm run dev` compila a fonte atual. Para exercitar o build publicado localmente,
registre o `git rev-parse HEAD`, execute `npm run build` e só então `npm start`;
um `dist/` anterior pode pertencer a outro HEAD.

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

### CLI local recuperável

O repositório inclui uma CLI Node 22 para publicar exatamente um arquivo Markdown.
Escolha também um caminho novo e explícito para o arquivo de operação. Ele registra
a chave idempotente e os metadados sem guardar a credencial ou o texto do plano:

```sh
export MD_COLAB_PUBLISH_TOKEN='mdp_substitua_pela_credencial_copiada'
npm run --silent publish:markdown -- \
  --file ./plano.md \
  --origin https://seu-dominio.example \
  --operation ./.md-colab-publicacao/plano.json
```

O diretório do arquivo de operação é criado com permissões locais restritas. A
operação é persistida e sincronizada antes da única tentativa de rede. Preserve
esse arquivo: se houver timeout, perda da resposta ou erro de rede, repita o mesmo
comando com o mesmo arquivo Markdown, origem, operação e credencial. A CLI usa a
mesma chave e o mesmo payload, inclusive quando já existe recibo, para confirmar
o resultado no servidor. Ela não repete a requisição automaticamente.

É possível acrescentar `--title 'Título para exibição'` na primeira execução. Em
repetições, omita o argumento para reutilizar o título registrado ou forneça
exatamente o mesmo valor. O Markdown pode ser movido e passado pelo novo caminho
se o conteúdo continuar idêntico; o nome original enviado fica preservado na
operação. Conteúdo, título explícito, origem ou credencial divergentes são recusados
antes da rede. Para publicar o mesmo plano como um novo documento, escolha outro
caminho ainda inexistente para `--operation`.

A credencial é aceita somente em `MD_COLAB_PUBLISH_TOKEN`. Não a coloque em
argumentos, URLs, Markdown ou arquivo de operação. A origem deve ser a raiz HTTPS
do serviço; HTTP é aceito apenas em loopback local. A CLI não segue redirects,
não abre o navegador, não lê referências ou arquivos vizinhos e não executa o
conteúdo. Em sucesso, a saída JSON contém `documentId`, `publicationId` e `url`.
O timeout padrão de uma tentativa é 30 segundos e pode ser reduzido localmente
com `MD_COLAB_PUBLISH_TIMEOUT_MS`.

Antes do envio, a CLI avisa em stderr sobre links e imagens que apontam para
arquivos locais, caminhos relativos, `file://`, caminhos Windows/UNC, URLs sem
protocolo, `data:` ou esquemas não suportados. O aviso não altera o Markdown, o
payload, o digest ou a operação, e não pede confirmação adicional. Apenas o
Markdown escolhido é publicado: torne o plano autocontido ou use uma URL HTTP(S)
explícita para recursos externos. Links `mailto:` continuam utilizáveis, mas não
são aceitos como imagens.

O arquivo de operação pressupõe um filesystem local com criação exclusiva,
hard links, rename atômico e sincronização. Preservá-lo permite recuperar respostas
perdidas; ele não protege contra exclusão ou perda do próprio disco.

A skill versionada [md-colab-publish](skills/md-colab-publish/SKILL.md) orienta
agentes a preparar e publicar esse plano pela CLI real. Ela permanece no repositório
e não é instalada globalmente de forma automática.

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
- Títulos têm âncoras estáveis e links de seção navegam no próprio documento.
  Links e imagens que dependem de recursos não publicados são explicados no leitor;
  recursos locais não são buscados nem enviados.
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

MCP, editor, versionamento e funcionalidades de IA ficam para outra etapa.
