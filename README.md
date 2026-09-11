# Markdown compartilhado

Importe um Markdown, compartilhe com e-mails específicos e receba comentários.
O dono importa e compartilha o link; quem recebe pode ler e comentar.

A rota `/` apresenta o produto sem consultar documentos ou exigir uma sessão.
A entrada e a lista privada ficam em `/documentos`; links de convite continuam
abrindo somente o plano correspondente em `/d/:id`.

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
declarado em `package.json` é Node 22.16.0; a versão exercitada neste procedimento
e na CI é 22.22.3. Wrangler 4.92.0 vem do lockfile.

```sh
npm ci
cp .env.example .env.local
npm run db:status:local -- --persist-to .wrangler/state
npm run db:migrate:local -- --persist-to .wrangler/state
npm run dev
```

O Wrangler aplica as migrações versionadas de `drizzle/` na ordem e registra o
ledger no banco;
repetir o comando não reaplica DDL. Use sempre um `--persist-to` explícito e não
reutilize a persistência de outra sessão. Se `status` encontrar schema sem ledger,
`migrate` recusa a escrita: siga o [runbook de D1](docs/d1-recovery.md) para
diagnosticar um legado conhecido, fazer backup e adotar o histórico de forma
explícita. Não execute novamente os SQLs históricos à mão.

Preencha `.env.local` com a origem exata do servidor e a lista de autores (ou o
e-mail legado do dono). A chave deve permanecer nesse arquivo ignorado pelo Git;
não a coloque no código ou em mensagens.

`npm run dev` compila a fonte atual. Para exercitar o build publicado localmente,
registre o HEAD que o gerou, faça o build e inicie o preview a partir da raiz do
checkout:

```sh
git rev-parse HEAD
npm run build
npm start -- --env-file "$PWD/.env.local" --port 3000 --persist-to .wrangler/state
```

Nesse exemplo, defina `APP_ORIGIN=http://localhost:3000` em `.env.local`; a origem
e a porta precisam corresponder. Escolha uma porta e uma persistência próprias para
esta sessão, sem reutilizar processos, bancos ou dados de outro ambiente. Um
`dist/` anterior pode pertencer a outro HEAD.

No preview compilado, a configuração do Wrangler fica em `dist/server`; por isso,
um `--env-file` relativo é resolvido a partir desse diretório. O caminho absoluto
`"$PWD/.env.local"` referencia o arquivo ignorado fora de `dist`, sem copiar
segredos para o artefato. A configuração local, por si só, não envia e-mails.

### Runtime Node standalone

O build Node mantém os mesmos fluxos da aplicação e grava SQLite persistente fora
do artefato. A inicialização e as migrações são explícitas; o processo recusa banco
ausente, pendente, legado ou divergente antes de escutar. Para container, backup,
restore sanitizado, permissões e proxy confiável, siga o
[runbook do runtime Node](docs/node-operations.md). O preview Workers continua em
`npm start`; a produção Node usa `npm run start:node` ou o launcher da imagem.

## Acesso por e-mail

- `APP_ORIGIN`: origem canônica, sem caminho. HTTPS na hospedagem;
  HTTP permitido apenas em localhost ou 127.0.0.1. A instância atual usa
  `https://collab.openprd.ai`.
- `APP_AUTHOR_MODE`: `allowlist` limita criação à lista configurada; `open`
  permite que qualquer pessoa crie planos depois de confirmar a posse do e-mail.
  Ausente ou vazio usa `allowlist`; outro valor torna a configuração inválida.
- `APP_AUTHOR_EMAILS`: lista de e-mails autorizados a importar documentos no modo
  `allowlist`, separados por vírgula. Espaços e maiúsculas são normalizados e
  repetições são ignoradas. Lista vazia nunca ativa autoria aberta.
- `APP_OWNER_EMAIL`: configuração legada opcional. O e-mail continua autorizado
  a importar documentos mesmo quando não aparece em `APP_AUTHOR_EMAILS`.
- `APP_OWNER_NAME`: nome exibido nos comentários do dono legado, opcional.
- `MAX_OWNED_DOCUMENTS`: total de planos próprios por autor; padrão `100`.
- `MAX_COMMENTS_PER_DOCUMENT`: total de comentários por plano; padrão `500`.
- `MAX_ACTIVE_SHARES_PER_DOCUMENT`: total de convidados ativos por plano;
  padrão `100`.
- `MAX_REVISIONS_PER_DOCUMENT`: total de revisões por plano, incluindo a
  inicial; padrão `100`.
- `RESEND_API_KEY`: chave do serviço de envio.
- `MAIL_FROM`: endereço remetente em domínio verificado no serviço.
- `NOTIFICATION_DRAIN_LIMIT`: máximo de entregas examinadas por ciclo; padrão `10`.
- `NOTIFICATION_DRAIN_INTERVAL_MS`: intervalo do runner Node; padrão `30000`.
- `NOTIFICATION_LEASE_SECONDS`: duração do lease; padrão `60` e mínimo `15`.
- `NOTIFICATION_RETRY_BASE_SECONDS`: base exponencial de retry; padrão `30`.

O adaptador usa a [API oficial do Resend](https://resend.com/docs/api-reference/emails/send-email).
Para enviar a convidados, configure um remetente autorizado no serviço. As
variáveis da hospedagem são independentes de `.env.local` e precisam ser
configuradas como valores de execução; a chave deve ser um segredo.

Comentários confirmados e novas revisões gravam os avisos no mesmo commit e não
aguardam o Resend. Uma revisão avisa somente participantes verificados que já
comentaram no plano e ainda têm acesso naquele instante; não há envio retroativo
nem aviso para convites silenciosos. O e-mail abre diretamente o comentário ou o
snapshot exato, sem incluir Markdown, título, arquivo ou resumo no corpo.
O processo Node inicia um drain limitado automaticamente; o Worker exporta um
handler `scheduled` e inclui o cron de um minuto no artefato. Publicar a mudança é
uma operação separada e é o que ativa esse cron no ambiente remoto. Em
`ACCESS_MODE=test`, nenhum desses runners envia avisos. Consulte o
[runbook da outbox](docs/notification-operations.md) para inspeção, bloqueios e
reconciliação explícita.

Na entrada em `/documentos`, `APP_AUTHOR_MODE=open` permite que qualquer
pessoa solicite seu
primeiro link; ela só cria planos depois de confirmar a posse do e-mail. Em
`allowlist`, o primeiro link sem convite continua restrito aos e-mails configurados.
A confirmação cria a conta; logins seguintes recuperam a mesma identidade e os
planos próprios ou compartilhados. Cada plano permanece privado: ser autor não dá
acesso ao plano de outra pessoa, que exige convite específico. Ao compartilhar, o
convidado recebe seu próprio link; não precisa definir senha nem ter ChatGPT.
O link expira em 15 minutos e funciona uma vez. Uma confirmação na página evita
que uma simples prévia de link feita pelo serviço de e-mail o consuma.
Links vencidos podem ser solicitados de novo na entrada ou reenviados pelo dono.

Os tokens têm 256 bits aleatórios; só hashes são armazenados no banco. A sessão
fica em cookie HttpOnly, SameSite=Lax e Secure em HTTPS, com validade de sete dias.
As permissões por documento são verificadas no servidor a cada leitura ou escrita.
Remover um convidado invalida convites antigos e bloqueia leitura e comentários,
mesmo com uma sessão aberta; comentários anteriores são preservados.

### Conversas de comentários

Cada comentário sem `rootId` inicia uma conversa e recebe um `root_id` igual ao
seu próprio UUID. Uma resposta envia o UUID dessa raiz em `rootId`; o servidor
deriva a autoria da sessão, verifica novamente o acesso ao plano na escrita e
aceita somente uma raiz do mesmo plano. Respostas não recebem uma nova citação ou
offset: elas preservam o contexto publicado pela raiz. Não há aninhamento além
desse nível.

Cada plano tem um snapshot inicial imutável, e `source_revision_id` preserva a
revisão vista por cada raiz e suas respostas. A API autoriza a leitura de uma
revisão pelo plano. O autor pode escolher outro arquivo Markdown, registrar um
resumo e indicar raízes ou respostas consideradas para publicar uma revisão
sobre a base que viu. Conflitos preservam a tentativa e exigem atualizar a base
e publicar de novo explicitamente; um UUID identifica o recibo exato. Críticas
antigas abrem o snapshot de origem em um painel somente leitura. Histórico e
metadados são paginados; cada snapshot pode ser aberto por um link próprio e
comparado localmente, linha a linha, com outra revisão carregada. Comparações
grandes exibem um limite explícito e mantêm os dois originais acessíveis. Abrir,
comparar ou atualizar o histórico não altera rascunho, referência ou publicação
pendente. Ao publicar uma revisão, os contribuidores anteriores ainda autorizados
recebem um link para aquele snapshot; o envelope legado de publicação continua
igual.

Antes de formatar a revisão atual ou um snapshot de origem, o leitor mede o texto
linearmente. Linhas acima de 16 KiB UTF-8, blocos contínuos acima de 1.024 linhas
ou 64 KiB e documentos acima de 10.000 linhas são mostrados como Markdown bruto
somente leitura. Esse painel preserva e copia o texto completo, mantém links e
imagens inativos e não transforma sua seleção em uma nova citação. Comentários
gerais, respostas e citações já salvas continuam disponíveis.

O mesmo UUID só pode ser repetido com autor, plano, corpo, contexto e vínculo de
conversa idênticos. A listagem continua paginada pela sequência persistida; quando
uma página contém resposta cuja raiz ficou fora dela, a resposta JSON inclui essa
raiz em `roots`, sem avançar cursor nem aumentar o limite lógico de `comments`.
Enquanto a página permanece aberta, reenvio incerto mantém a conversa escolhida e
o texto; mudar de documento ou de sessão descarta esse vínculo local.

### Cotas totais do piloto

As quatro cotas são tetos totais, não limites por intervalo de tempo. Importações
manuais e publicações por API ou CLI contam juntas em `MAX_OWNED_DOCUMENTS`.
Quando o teto é alcançado, uma nova escrita retorna `409` com o código estável
`quota_exceeded`; não há `Retry-After`, repetição automática nem liberação por
espera. Revogar um convidado libera essa vaga. Planos e comentários não são
apagados para liberar vagas.

O operador pode ampliar os tetos alterando as variáveis para inteiros decimais
positivos até `Number.MAX_SAFE_INTEGER`. Reduzir um teto não remove nem oculta os
dados que já o excedem: planos, comentários e convidados existentes continuam
legíveis pelas mesmas páginas, e convidados ainda podem ser revogados. Uma
configuração ausente usa o padrão acima. Valor vazio, zero, negativo, fracionário,
com espaços, zero à esquerda ou acima do inteiro seguro é inválido.

Configuração inválida bloqueia somente uma nova escrita que dependa daquela cota.
Leituras e replays idempotentes com identidade, conteúdo, contexto e autorização
ainda válidos continuam recuperáveis. Corrija ou amplie a variável na configuração
de execução; não apague dados nem reaplique migrações.

A importação manual usa o cookie da sessão e envia `POST /api/documents` com
`id` (UUID gerado antes da tentativa), `authorId` igual à identidade da sessão,
`markdown`, `filename` e `title` opcional não vazio. Repetir o mesmo UUID, autor,
contexto e conteúdo retorna o mesmo plano; qualquer divergência retorna `409` sem
sobrescrever o registro. Após timeout, resposta inválida ou falha de rede, a página
mantém o arquivo e a operação somente em memória e oferece verificar o resultado
ou reenviar os mesmos valores. Fechar ou recarregar perde essa retomada; procure o
plano na lista antes de iniciar uma nova importação.

## Publicação por API

Uma pessoa autenticada por e-mail e atualmente habilitada como autora pode abrir
**API** no cabeçalho, escolher a finalidade, dar um nome à credencial e copiá-la.
**Publicação inicial** cria planos sem ler feedback. **Leitura de feedback** fica
vinculada a um único plano próprio, escolhido por ID ou link do mesmo serviço, e
não publica planos ou revisões. O servidor confirma o vínculo e a propriedade; o
texto digitado na interface não concede acesso por si só. Credenciais existentes
continuam sendo apenas de publicação inicial e não são convertidas.

O segredo começa com `mdp_`, contém 256 bits aleatórios e aparece somente nessa
criação. O banco guarda apenas seu hash. Cada credencial expira 90 dias depois da
emissão; podem existir até 10 credenciais ativas por pessoa, com nomes de até 80
caracteres. A listagem mostra finalidade e, quando aplicável, o plano vinculado,
sempre somente da própria conta. A pessoa pode revogar suas credenciais mesmo se
deixar de estar habilitada para criar planos. A emissão aceita até 20 tentativas
por pessoa a cada 24 horas.

A gestão usa o cookie da sessão verificada:

- `GET /api/publishing-tokens` retorna `{ "viewerId", "credentials" }`, sem
  segredo ou hash;
- `POST /api/publishing-tokens` recebe `{ "name": "Notebook pessoal" }` e
  retorna `{ "viewerId", "token", "credential" }`, com o segredo somente nessa
  resposta;
- para leitura, o mesmo `POST` recebe
  `{ "name": "Agente de revisão", "scope": "plan_read", "documentId": "…" }`;
- `DELETE /api/publishing-tokens/:id` retorna `{ "viewerId", "credential" }` e
  revoga uma credencial própria.

Uma credencial `publish` autentica exclusivamente `POST /api/publications`. Uma
credencial `plan_read` autentica exclusivamente a API de feedback do plano ao qual
foi vinculada. Nenhuma substitui o cookie na gestão de credenciais, na interface
de leitura, em comentários ou em compartilhamento. A publicação também confere
novamente a política atual de autoria e fica indisponível em `ACCESS_MODE=test`.
Credenciais expiradas ou revogadas são recusadas.

A requisição aceita JSON com `markdown`, `filename` e `title` opcional. O Markdown
continua limitado a 1 MB e é preservado como recebido. `Idempotency-Key` é
obrigatório, aceita de 1 a 128 caracteres ASCII visíveis e fica isolado por autor.
Repetir a mesma chave e o mesmo conteúdo retorna os mesmos identificadores e URL;
usar a chave com conteúdo diferente retorna `409` sem alterar o documento. A
operação cria somente um documento e seu registro de publicação: não importa
arquivos referenciados pelo Markdown, não envia convites e não atualiza planos.

Falhas da API incluem um `requestId` aleatório no JSON para correlação. Os eventos
`api_failure` emitidos pela aplicação registram somente esse identificador e
método, rota lógica, categoria e status de conjuntos controlados. Eles não incluem
URL, query, cursor, identificadores recebidos, e-mail, conteúdo, token, nem nome ou
mensagem livre de exceção; rotas desconhecidas usam a categoria fixa
`unknown_route`. Essa garantia se limita aos eventos da aplicação. Logs de acesso
do Wrangler ou da plataforma seguem a configuração própria desses ambientes.

### Leitura de feedback por API

A superfície de agente aceita somente `Authorization: Bearer <credencial>` com
uma credencial `plan_read` do plano exato. Ela não usa a sessão do navegador como
fallback e fica indisponível em `ACCESS_MODE=test`. As rotas são somente `GET`:

- `/api/agent/documents/:id/feedback` cria o manifesto ou, com `?stamp=…`, faz a
  validação final da mesma observação;
- `/api/agent/documents/:id/feedback/comments?stamp=…&cursor=…` pagina comentários;
- `/api/agent/documents/:id/feedback/events?stamp=…&cursor=…` pagina eventos;
- `/api/agent/documents/:id/revisions/:revisionId?stamp=…` lê um snapshot exato.

O manifesto tem este formato:

```json
{
  "contract_version": 1,
  "document": {
    "id": "26e0cb70-9a3e-49d7-9ac0-5a11f4ca46e3",
    "title": "Plano",
    "filename": "plano.md",
    "current_revision_id": "35e0cb70-9a3e-49d7-9ac0-5a11f4ca46e4",
    "current_revision_ordinal": 2
  },
  "counts": { "comments": 72, "events": 4, "revisions": 2 },
  "stamp": "…"
}
```

Cada página contém até 50 itens, `next_cursor` (`null` na última página) e o
mesmo `stamp`. Comentários expõem `id`, `root_id`, `author_id`, `author_name`,
`body`, `quote`, `source_start`, `source_revision_id`, `created_at` e `is_root`.
Somente raízes incluem `conversation` com `state`, `version`, `decision`,
`decision_reason` e `reply_count`; em respostas, `conversation` é `null`. O
`source_start` é a âncora do bloco do renderizador, não um byte offset nem a
posição garantida de uma frase.

Eventos expõem `id`, `root_id`, `actor_id`, `actor_name`, `base_version`,
`version`, `action`, `state`, `decision`, `decision_reason`, `reason` e
`created_at`. O snapshot retorna `{ "revision", "stamp" }`; `revision` contém
`id`, `document_id`, `ordinal`, autor/nome público, título, nome de arquivo,
Markdown original, `base_revision_id`, resumo, `considered_comment_ids` e data.
O Markdown permanece dado e não é renderizado ou executado pela API.

`stamp` e `cursor` são metadados operacionais opacos, vinculados à credencial,
ao plano e à observação. Cursores de comentários e eventos são independentes.
Depois de consumir as páginas e os snapshots necessários, repita o manifesto com
o mesmo `stamp`. Uma crítica, decisão ou revisão concorrente retorna `409` com
`code: "feedback_changed"`; reinicie a coleta com um manifesto sem selo. Essa
validação confirma completude naquele instante, sem prometer atualidade contínua.
`counts.revisions` informa o total observado, mas esta API não lista todo o
histórico. O comando abaixo coleta o feedback e os snapshots necessários sem
transformar esse total numa exportação de todo o histórico.

### Coleta local de feedback

Crie pela interface uma credencial **Leitura de feedback** vinculada ao plano e
escolha um diretório de saída ainda inexistente, cujo diretório pai já exista:

```sh
export MD_COLAB_PLAN_TOKEN='mdp_substitua_pela_credencial_copiada'
npm run --silent feedback:markdown -- \
  --origin https://seu-dominio.example \
  --document 26e0cb70-9a3e-49d7-9ac0-5a11f4ca46e3 \
  --output ./.md-colab-feedback/coleta-001 \
  --file ./plano-local.md
```

`--file` é opcional. Quando indicado, deve ser exatamente um arquivo regular
UTF-8 de até 1 MiB; ele é somente lido e comparado byte a byte com a revisão
corrente observada. BOM e terminações de linha contam. O resultado é
`identical`, `different` ou `not_compared` e não autoriza substituir, publicar ou
executar o arquivo local.

O comando usa somente `MD_COLAB_PLAN_TOKEN`, não envia cookies, não segue
redirects e faz apenas os `GET` documentados acima. Ele não abre links, lê outros
arquivos, chama modelos nem executa conteúdo do plano ou do feedback. O timeout
padrão é 30 segundos por requisição; `MD_COLAB_FEEDBACK_TIMEOUT_MS` aceita de 1 a
300000 ms. Cada resposta fica limitada a 8 MiB, o total recebido a 256 MiB, cada
coleção a 10000 registros e a coleta a 1000 snapshots necessários.

O diretório é reservado de forma exclusiva com modo `0700`; destinos existentes,
inclusive links simbólicos, são recusados. Os Markdown preservam bytes UTF-8 e são
gravados como `revision-<sha256-do-UUID-exato>.md` com modo `0600`. Assim, IDs que
diferem somente por caixa continuam distintos também em filesystems sem distinção
de caixa. `context.json`, também privado, relaciona esses arquivos aos IDs, hashes,
metadados, comentários, eventos e comparação, sem duplicar o Markdown nem incluir
token, selo, cursor ou metadados da credencial.

O `context.json` é publicado por último. Sua presença significa que arquivos e
coleções foram verificados e o mesmo selo foi validado naquele instante; não
promete que o servidor permanecerá sem mudanças. Uma falha anterior preserva o
diretório incompleto sem `context.json`. Se o link final já ocorreu e a
sincronização ou o stdout falhou, o comando informa confirmação incerta: preserve
e inspecione o diretório, sem repetir no mesmo destino. Toda nova coleta exige
outro diretório inexistente.

Em sucesso, stdout contém somente `origin`, `documentId`, `currentRevisionId`, os
caminhos do diretório/contexto e `comparison`. Nomes, comentários e Markdown
privados ficam nos arquivos. Uma coleta completa contém a revisão corrente e as
revisões de origem citadas pelos comentários; `base_revision_id` é metadado e não
provoca busca recursiva de todo o histórico. Republicar uma revisão por credencial
continua fora deste recorte.

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
- Markdown acima do orçamento de formatação permanece inteiro em um painel de
  texto bruto rolável e copiável, sem executar as passagens GFM pesadas.
- Documentos e comentários persistidos em SQLite/D1.
- Compartilhamento por nome opcional e e-mail, com convite e reenvio.
- Comentários gerais ou em trechos selecionados, com autor e data.
- Atualização de comentários ao voltar à página e a cada 15 segundos, com aviso
  visível quando a atualização falha.
- Reenvio explícito de comentário com a mesma operação sem duplicação. Uma
  tentativa incerta e sua redação permanecem somente em memória enquanto a página
  está aberta; não há recuperação do rascunho depois de fechar ou recarregar.

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
npm run build:node
npm run test:node:smoke
```

Os testes usam SQLite com as migrações reais e um transporte de e-mail em memória.
Cobrem importação, convite, autenticação, comentário, restrição de convidados,
revogação, expiração, consumo concorrente do link, logout, limites, rejeição de
identidades forjadas, origem da solicitação e recuperação de falha de envio.

## Organização

- `components/document-workspace.tsx`: importação, leitura, compartilhamento e comentários.
- `components/revision-history.tsx`: histórico, snapshots exatos e comparação local limitada.
- `components/email-login.tsx`: solicitação de link e confirmação de acesso.
- `lib/document-service.ts`: consultas e permissões por documento.
- `lib/auth-service.ts`: links de acesso, sessões e limites.
- `lib/mailer.ts`: transporte de e-mail.
- `lib/api-handler.ts`: endpoints e autorização de ações.
- `app/api/[...path]/route.ts`: integração da API com o ambiente hospedado.
- `db/schema.ts` e `drizzle/`: schema e migrações.

MCP, editor e funcionalidades de IA ficam para outra etapa.
