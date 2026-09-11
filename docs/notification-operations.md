# Operação da outbox de avisos

Comentários em documentos autenticados criam um evento e um snapshot dos
destinatários na mesma transação. O comentário não depende do provedor: Node drena
a outbox no processo existente, e Workers usa o handler `scheduled` do export
default. O cron versionado só se torna ativo quando esse artefato é publicado.
`ACCESS_MODE=test`, documentos de teste e identidades declaradas no teste nunca
produzem envio externo.

Cada primeira tentativa persiste o payload e a chave do Resend antes da chamada.
Retries usam esses mesmos bytes. Falhas incertas podem ser repetidas somente com a
mesma chave dentro da janela de 24 horas do Resend; o runner usa uma margem maior
que seu timeout e bloqueia antes da borda. Um bloqueio incerto permanece bloqueado
até haver evidência externa explícita. A ausência de um identificador ou uma busca
sem resultado não prova que o e-mail deixou de ser aceito.

## Ativação e verificação

O comando `npm run start:node` e o `CMD` da imagem Node usam
`scripts/start-node.ts`: depois de
validar o banco e iniciar o servidor existente, ele inicia o timer no mesmo
processo. Verifique a operação com `inspect` no SQLite daquele processo e confirme
que uma entrega sintética passa de `pending` para `sent`, ou para o diagnóstico
esperado, sem uma página aberta.

No Worker, `npm run build` produz `dist/server/wrangler.json` com `main` apontando
para o wrapper e `triggers.crons` versionado. A publicação desse artefato ativa o
cron; antes dela, invoque o handler `scheduled` localmente contra um D1 sintético
e bloqueie o egress real, depois confirme a transição pelo `inspect` usando o
mesmo `--config` e `--persist-to`. Um status HTTP isolado não prova o drain.

## Inspeção limitada

O comando lista `blocked` por padrão, até 50 linhas. Use `--status` com `pending`,
`suppressed`, `sent` ou `all`; `--limit` aceita 1 a 100. Se houver outra página, a
saída inclui `nextCursor`, que deve ser passado sem alterações em `--cursor`.
`--delivery` consulta um identificador exato e não pode ser combinado com cursor.

No SQLite do runtime Node:

```sh
npm run notification:ops -- inspect \
  --runtime node \
  --db /data/md-colab.sqlite \
  --status blocked
```

No D1 local, primeiro gere o build Workers e use a mesma configuração e o mesmo
`--persist-to` do processo exercitado:

```sh
npm run build
npm run notification:ops -- inspect \
  --runtime d1 \
  --target local \
  --database DB \
  --config "$PWD/dist/server/wrangler.json" \
  --persist-to "$PWD/outputs/notification-qa/d1" \
  --status blocked
```

Para um D1 remoto suportado, o operador precisa usar a configuração exata do
deployment, com o binding ou nome que resolve para aquele database ID. O comando
exige repetir esse valor em `--confirm-remote`; isso não substitui a conferência da
conta, configuração e alvo antes da escrita:

```sh
npm run notification:ops -- inspect \
  --runtime d1 \
  --target remote \
  --database DB_PRODUCAO \
  --confirm-remote DB_PRODUCAO \
  --config /caminho/revisado/wrangler.json \
  --status blocked
```

O modo D1 executa consultas pelo Wrangler. A reconciliação abaixo é um único
`INSERT`; triggers do schema validam estado, lease e acesso e aplicam a mudança ou
criam a nova geração dentro da mesma mutação. Não há sequência de comandos de
escrita fingindo uma transação.

## Reconciliação explícita

Se o Resend ou outra evidência durável confirmar que a mensagem foi aceita, grave
o identificador retornado pelo provedor:

```sh
npm run notification:ops -- reconcile \
  --runtime node \
  --db /data/md-colab.sqlite \
  --delivery DELIVERY_ID \
  --action-id UUID_NOVO_DA_ACAO \
  --operator IDENTIDADE_ESTAVEL_DO_OPERADOR \
  --evidence accepted \
  --provider-id PROVIDER_ID \
  --note 'Referência privada da confirmação externa'
```

Somente uma confirmação externa explícita de não entrega permite uma nova
tentativa. Uma resposta durável 401 ou 422 comprova a rejeição daquela tentativa
apenas quando não houve incerteza anterior. Depois de timeout ou desconexão, uma
rejeição posterior não resolve o possível aceite anterior: a evidência precisa
cobrir todas as tentativas incertas. A operação preserva a geração bloqueada e
cria outra entrega com payload, chave e janela novos:

```sh
npm run notification:ops -- reconcile \
  --runtime d1 \
  --target local \
  --database DB \
  --config "$PWD/dist/server/wrangler.json" \
  --persist-to "$PWD/outputs/notification-qa/d1" \
  --delivery DELIVERY_ID \
  --action-id UUID_NOVO_DA_ACAO \
  --operator IDENTIDADE_ESTAVEL_DO_OPERADOR \
  --evidence confirmed_not_delivered \
  --note 'Referência privada da confirmação externa de não entrega'
```

Repita exatamente o mesmo `action-id`, operador, evidência e nota para recuperar a
resposta de uma operação cujo retorno foi perdido. Reutilizar o identificador com
outro conteúdo é recusado. Ações concorrentes sobre a mesma geração não criam duas
entregas. Destinatários revogados, gerações com lease ativo e entregas já
confirmadas ou suprimidas não são reconciliáveis. A supressão impede novas
tentativas; ela não retira uma mensagem que o provedor já tenha aceitado ou que
esteja em voo.
