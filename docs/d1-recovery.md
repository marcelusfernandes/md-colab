# Migração e recuperação do D1

Este runbook prepara operações reviewáveis. Ele não autoriza acesso remoto,
deploy, custo ou alteração de dados existentes. Os helpers recusam `--remote`,
operam somente nesta worktree e exigem um caminho explícito terminado em
`.wrangler/state`.

## Antes de escrever

Use Node.js 22.22.3, npm e Wrangler 4.92.0 do lockfile:

```sh
node --version
npm ci
npx --no-install wrangler --version
git rev-parse HEAD
```

Identifique o ambiente, o config e a persistência exatos. Pare o app e qualquer
outro escritor durante inspeção, exports, adoção e restore. Chamadas separadas do
Wrangler não bloqueiam escritores concorrentes.

```sh
STATE=.wrangler/state
npm run db:status:local -- --persist-to "$STATE"
```

O status consulta `sqlite_schema` e `d1_migrations`; ele não chama
`wrangler d1 migrations list`, porque no Wrangler 4.92.0 esse comando cria uma
tabela de ledger vazia até em um legado. Interprete o resultado assim:

- `objectCount: 0`: banco vazio; `db:migrate:local` pode criar o schema atual.
- `tracked: true` e ledger não vazio: banco rastreado; revise o ledger e aplique
  somente as migrações pendentes.
- objetos existentes sem ledger, ou ledger vazio: legado ou estado parcial;
  `db:migrate:local` recusa antes do apply.

Se o banco rastreado contém dados, produza e valide o backup descrito abaixo
antes de migrar. O helper `db:migrate:local` faz o preflight do ledger, mas não
cria esse backup operacional.

```sh
npm run db:migrate:local -- --persist-to "$STATE"
```

`wrangler.local.json` aponta `migrations_dir` para `drizzle`. Os SQLs e os
snapshots/journal `0000..0003` já aplicados são históricos imutáveis. Uma nova
mudança de schema deve acrescentar outra migração.

## Legado local conhecido até 0002

O único prefixo adotável é `0000_mute_microchip`, `0001_email_access` e
`0002_link_test_mode`. Primeiro faça apenas o diagnóstico em um diretório novo:

```sh
npm run db:adopt-legacy:local -- \
  --persist-to "$STATE" \
  --evidence-dir outputs/legacy-inspect-AAAAMMDD-HHMMSS \
  --through 0002_link_test_mode
```

O helper cria um D1 de referência com esse prefixo via migrações nativas e exige
igualdade exata de tabelas, colunas/defaults, índices, FKs, triggers e views.
Exclui somente o objeto D1 interno conhecido `_cf_METADATA` e objetos reservados
`sqlite_*`; qualquer outro objeto extra é divergência. Também exige
`PRAGMA foreign_key_check` limpo. Existir uma tabela isolada nunca determina a
versão.

Revise `inspection.json`. Para adotar, mantenha o banco quiescente e escolha outro
diretório de evidência ainda inexistente:

```sh
npm run db:adopt-legacy:local -- \
  --persist-to "$STATE" \
  --evidence-dir outputs/legacy-adopt-AAAAMMDD-HHMMSS \
  --through 0002_link_test_mode \
  --adopt
```

Antes de escrever o ledger, o helper cria um export completo privado e um par
schema/dados com allowlist exata das tabelas 0002. Restaura o par em outro D1,
reexporta e compara o hash; depois reexporta a origem e revalida dados, schema,
FKs e ausência de ledger. Qualquer drift recusa a adoção. O `--adopt` registra
somente as três entradas produzidas pelo próprio Wrangler e preserva os dados.
Depois, confira o status e aplique `0003` com `db:migrate:local`.

Não use esse resultado sintético para diagnosticar ou adotar um banco remoto.

## Backup e restore em destino separado

Backups contêm Markdown privado, e-mails, hashes de sessão, magic links e
credenciais. Use diretório ignorado pelo Git, permissões `0700` no diretório e
`0600` nos arquivos; não publique SQL nem conteúdo em logs. Não sobrescreva nem
reutilize um destino de restore falho.

No Wrangler 4.92.0, `d1 export --local` não aceita `--persist-to`: ele escolhe
`.wrangler/state` ao lado do arquivo de configuração. Por isso cada ambiente
isolado mantém seu próprio `wrangler.local.json`. Confirme no log o caminho exato
`.../.wrangler/state/v3/d1` antes de confiar no export.

Com a origem parada, produza como uma unidade: um backup completo intacto, um
export `--no-data` e um export `--no-schema` com `--table` repetido para a lista
exata de tabelas de aplicação e `d1_migrations`. Verifique antes que não há tabela,
trigger ou view inesperada. Guarde caminhos e SHA-256 dos três arquivos. O split
é necessário porque o export completo intercala inserts antes das tabelas
referenciadas; a allowlist nativa evita importar `sqlite_sequence` duas vezes.
Não edite o SQL, não remova `_cf_` por filtro e não aplique migrações no destino.

Crie um ambiente de destino novo com `db:status:local`; em seguida execute primeiro
o arquivo de schema e depois o arquivo de dados com `wrangler d1 execute DB
--local --persist-to <destino>/.wrangler/state --config
<destino>/wrangler.local.json --file <arquivo> --yes`. Mantenha o destino offline
se qualquer etapa falhar.

Antes de abrir tráfego, reexporte o destino e confira:

- IDs, contagens e hashes esperados de todos os dados de aplicação;
- propriedade do plano, convite, autoria do comentário e relações da publicação;
- ledger completo e migrações pendentes vazias;
- schema/índices/FKs e `PRAGMA foreign_key_check` sem linhas;
- marcador igual ao da origem e diferente do ambiente de controle, comprovando a
  identidade do D1.

O ensaio sintético reproduzível faz esse roundtrip sem tocar dados existentes:

```sh
npm run db:recovery-check:local -- \
  --output-dir outputs/qa-task22/run-AAAAMMDD-HHMMSS
```

## Recuperação e produção

Rollback de código não reverte dados. Uma restauração troca estado persistido e
precisa de decisão operacional própria. Um backup antigo pode ressuscitar sessões
encerradas, magic links já consumidos e credenciais revogadas depois do snapshot.
Mantenha o destino restaurado offline até reconciliar eventos posteriores e
invalidar artefatos de autenticação afetados.

Na hospedagem Sites, migrações Drizzle são aplicadas e registradas antes do upload
do Worker; uma publicação falha pode já ter aplicado DDL. A lista de tabelas de
usuário não prova ausência de ledger remoto. Esse histórico gerenciado é distinto
do ledger Wrangler local deste runbook, e o conector Sites não oferece export ou
restore de D1. Uma operação futura precisa confirmar conta, projeto, database ID,
backup verificável, janela quiescente, fronteira aplicada/não aplicada e plano de
reabertura antes de qualquer escrita.

Recuperar a mesma instância é diferente de transportar dados para terceiros. Esse
transporte exige a política de privacidade, autorização e retenção da etapa M4.
