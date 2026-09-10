# Operação do runtime Node

O runtime Node é uma alternativa de produção ao Worker e usa o mesmo produto e o
mesmo histórico imutável em `drizzle/`. O artefato standalone escuta em `PORT`
(`3000` por padrão) e persiste um único SQLite em `MD_COLAB_DB_PATH`
(`/data/md-colab.sqlite` na imagem). O runtime usa `node:sqlite`, disponível no
Node 22 e ainda marcado como experimental nessa versão.

## Preparação e configuração

Use no mínimo Node.js 22.16.0; a imagem e a CI usam Node.js 22.22.3. Crie o diretório de dados antes do processo, restrinja-o a
`0700` e torne-o gravável pelo UID/GID efetivo. A imagem executa como o usuário
`node` (UID/GID 1000) por padrão, mas o operador pode definir outro UID/GID, como
1001:1001, sem depender de entrada em `/etc/passwd` nem de uma home gravável.
O banco e os backups são criados como `0600`.

Copie `runtime.env.example` para um arquivo privado ignorado pelo Git e substitua
origem, autores, remetente e segredo. Não imprima o arquivo durante diagnóstico e
não o inclua no build da imagem. `ACCESS_MODE=email` é o modo esperado para
convidados reais; `ACCESS_MODE=test` aceita qualquer e-mail declarado e serve
somente para testes isolados.

Na imagem publicada, defina as variáveis em execução e monte `/data`. Não publique
a porta 3000 diretamente no host. Coloque o container em uma rede privada acessível
somente pelo proxy confiável.

## Migração explícita

O servidor nunca cria nem migra um banco. O launcher valida integridade, chaves
estrangeiras, sequência do ledger, checksums e schema antes de importar o servidor;
um banco ausente, legado desconhecido, divergente ou com migração pendente encerra
o processo. `/api/health` indica apenas que o processo HTTP responde e
`/api/ready` consulta o banco, retornando apenas `ready` ou `unavailable`.

Em um checkout, consulte e inicialize um banco novo assim:

```sh
npm run db:node -- status --database /data/md-colab.sqlite
npm run db:node -- migrate --database /data/md-colab.sqlite
npm run build:node
MD_COLAB_DB_PATH=/data/md-colab.sqlite npm run start:node
```

Dentro da imagem, use a CLI empacotada. Substitua `IMAGE` pelo digest ou pela tag
imutável revisada:

```sh
IMAGE=ghcr.io/marcelusfernandes/md-colab:sha-REVISAO
docker run --rm --user 1001:1001 \
  --volume /caminho/privado/dados:/data \
  --entrypoint node "$IMAGE" \
  --experimental-transform-types ops/scripts/node-db.ts \
  status --database /data/md-colab.sqlite
```

Troque `status` por `migrate` para um banco vazio. Em banco rastreado com migrações
pendentes, `migrate` exige um backup novo e consistente na mesma operação:

```sh
docker run --rm --user 1001:1001 \
  --volume /caminho/privado/dados:/data \
  --entrypoint node "$IMAGE" \
  --experimental-transform-types ops/scripts/node-db.ts \
  migrate --database /data/md-colab.sqlite \
  --backup-output /data/backups/pre-migrate-REVISAO.sqlite
```

Cada SQL e sua entrada no ledger `_md_colab_migrations` usam uma única transação.
Falha em DDL, checksum ou chave estrangeira reverte ambos. O comando repetido é
idempotente. Não edite nem reaplique SQL histórico e não adote manualmente um banco
com objetos sem ledger.

## Backup e restore isolado

Pare ou retire o app do tráfego para manutenção planejada. `backup` usa a API de
backup consistente do SQLite, verifica novamente o destino e recusa sobrescrever
arquivo existente:

```sh
npm run db:node -- backup \
  --database /data/md-colab.sqlite \
  --output /data/backups/md-colab-AAAAMMDD-HHMMSS.sqlite
```

Registre o caminho, tamanho e SHA-256 retornados e copie o arquivo para retenção
privada. Backups contêm Markdown, e-mails e hashes de autenticação.

`restore` também recusa sobrescrever e sempre escreve outro banco, mantendo o
snapshot intacto:

```sh
npm run db:node -- restore \
  --backup /data/backups/md-colab-AAAAMMDD-HHMMSS.sqlite \
  --output /data/restores/md-colab-restored.sqlite
```

O destino restaurado é sanitizado antes de ser disponibilizado: remove todos os
convites, sessões, magic links e limites de autenticação, e revoga todas as
credenciais de publicação ainda ativas. Os registros de credencial permanecem
para conservar referências de publicações. Documentos, comentários, contas e
publicações são preservados.

Um snapshot em um prefixo conhecido anterior também pode ser restaurado: o
resultado lista `pending`, permanece recusado pelo launcher e deve receber
`migrate --database <destino-restaurado>` explicitamente antes da partida. Schema,
ledger e checksums do prefixo ainda precisam coincidir exatamente; isso não adota
legado desconhecido.

Mantenha o destino offline enquanto confere contagens, propriedade, comentários,
publicações, ledger, checksum, `quick_check` e `foreign_key_check`. Reemita somente
convites e credenciais aprovados depois dessa reconciliação. Reinicie o app com o
novo caminho, descarte cursores de comentários antigos e recarregue os clientes.
O ensaio obrigatório é: backup, revogação posterior no banco ativo, restore em
outro caminho, reconciliação e confirmação de que sessão, convite e credencial do
snapshot continuam negados.

Rollback da imagem não reverte dados. Só volte a uma imagem cujo código reconhece
o schema já aplicado; para voltar dados, execute o procedimento de restore e sua
reconciliação como uma decisão operacional separada.

## Atualização e fronteira do proxy

Para atualizar: retire escritores, crie backup, confira `status`, aplique migrações
explícitas, selecione a imagem pelo digest revisado, inicie o app e espere
`/api/ready`. Depois confirme login, leitura, importação idempotente, convite,
comentário, revogação e publicação conforme o ambiente.

A limitação por endereço usa `CF-Connecting-IP`. Esse cabeçalho só é confiável
porque o app fica inacessível diretamente e o proxy o sobrescreve com o endereço
da conexão recebida; o proxy também deve remover valores de encaminhamento não
confiáveis. Se um cliente puder alcançar a porta do app ou controlar esse cabeçalho,
a cota por IP pode ser contornada. Essa fronteira pertence à configuração do proxy
e deve ser testada com um cabeçalho forjado antes de abrir tráfego.

Para preparar navegação sintética no modo de e-mail sem chamar o Resend, use
somente um banco temporário vazio já migrado:

```sh
npm run qa:node:fixture -- \
  --database /caminho/temporario/md-colab.sqlite \
  --output outputs/node-qa/cookies.json
```

O helper recusa banco com dados, cria dono, convidado, estranho, convite e sessões
sintéticas e grava os cookies em arquivo exclusivo `0600`. O diretório de saída é
privado e ignorado; nunca use tokens ou dados reais nesse ensaio.
