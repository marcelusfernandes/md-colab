# Workflow de desenvolvimento

Este guia orienta a coordenação do md-colab. Use as instruções atuais da skill
`agentic-setup:autonomous-loop` para o ciclo GitHub; não copie seu contrato para
os perfis nem mantenha uma segunda fila de tarefas em arquivos locais.

## Entrada e responsabilidade

| Pedido | Encaminhamento |
| --- | --- |
| Executar ou retomar um objetivo em loop | `orchestrator`, sempre com Astra. |
| Investigar código ou fatos externos | `researcher`, com pergunta delimitada. |
| Implementar uma tarefa bem especificada | `implementer`. |
| Implementação ambígua, mudança abrangente ou diagnóstico difícil | `senior_implementer`. |
| Revisar uma entrega | `reviewer`, em contexto independente. |
| Revisar acesso, dados, migrações ou integrações sensíveis | `security_reviewer`. |
| Exercitar uma jornada no browser | `browser_qa`. |

Uma sessão que recebe um objetivo completo pode convocar o orquestrador conforme
estas regras. O implementador que já recebeu uma subtarefa não assume o objetivo
inteiro. Durante a delegação, o principal acompanha resultados, conversa com o
usuário e encaminha mudanças; somente o orquestrador conduz aquele objetivo.
Se o usuário preferir a coordenação no principal, ele deve estar usando Astra.
Mencionar um modelo em AGENTS.md não troca o modelo da sessão.

Os perfis são acionados por necessidade; não é obrigatório convocar todos.
Respeite os limites de concorrência e de delegação do cliente. Se um coordenador
delegado não puder criar os especialistas necessários, devolva a coordenação ao
principal de forma explícita. Não simule delegação ou revisão independente.

## O que reaproveitar do plugin

Localize a skill instalada pelo catálogo de skills do cliente, leia seu SKILL.md
e o contrato referenciado. Use o diretório real da instalação, sem fixar um caminho
da máquina do autor nos arquivos do projeto. A instalação é pré-requisito para o
loop; a configuração deste repositório não instala nem modifica o plugin.

O plugin fornece o fluxo de planejamento, especificação, execução, revisão,
integração e retomada; os comandos `status`, `claim`, `land` e `finish`; e o
tratamento de checkpoints e tentativas de reparo. Siga suas regras atuais e as
autorizações do usuário. Instalar perfis ou criar backlog não concede publicação,
merge, ações de produção ou contato com terceiros.

O runner headless é opcional. Seu `--profile` seleciona um perfil de configuração
do CLI, não um arquivo de `.codex/agents/`. Um perfil de subagente também não é um
serviço independente nem garante continuidade depois de encerrar o cliente.

## Seleção de milestones, épicos e tarefas

O [roadmap no GitHub](https://github.com/marcelusfernandes/md-colab/milestones)
define resultados e sequência. Os épicos são objetivos individuais do plugin;
suas tarefas ficam no `Plan`. O plugin calcula a próxima tarefa dentro de um
objetivo, sem percorrer milestones nem executar objetivos aninhados recursivamente.

1. Recupere o escopo autorizado, a orientação recente do usuário e as decisões
   aceitas. Autorização para um épico não implica executar todas as milestones.
2. Reconcilie primeiro trabalho em andamento: issue, PR, branch, commit, checkout
   e sessão responsável. Retome apenas posse confirmada; um nome não prova abandono.
3. Quando o escopo incluir vários épicos, siga a sequência explícita do roadmap.
   Leia a descrição e os critérios de saída da milestone antes de escolher trabalho.
4. Escolha um épico com dependências e decisões satisfeitas. Respeite a prioridade
   registrada; na ausência dela, justifique a escolha pelo resultado que desbloqueia.
   Verifique dependências entre épicos diretamente: `status` não faz essa seleção.
5. Consulte `status` do épico selecionado. Um `Plan` vazio pede planejamento:
   detalhe a próxima tarefa útil com critérios observáveis e validação proporcional.
6. Dentro do épico, siga a escolha e o fluxo do plugin. Após cada entrega, registre
   evidências, reconcilie o estado e avance para a próxima tarefa permitida.
7. Conclua épicos e milestones pelos critérios acordados, incluindo validações
   de produto que não sejam código. Issues fechadas, sozinhas, não provam o resultado.
8. Avance a outro objetivo somente dentro do escopo já autorizado. Registre novas
   necessidades como propostas; preserve decisões de produto ainda pendentes.

Se houver bloqueio, diferencie falha reparável, espera externa e decisão pendente.
Continue trabalho independente permitido pelo fluxo; não contorne dependências
criando um objetivo equivalente. Use espera apropriada para CI/revisão, sem
consultas repetitivas que não tragam informação nova.

## Delegação, worktrees e integração

Cada brief deve conter objetivo, critérios de aceite, decisões aceitas, contexto
necessário, checkout/branch e caminhos corretos, limites de edição, validação,
formato da entrega e condições de parada. Inclua a issue e quem coordena o objetivo.

O fluxo instalado usa um coordenador e uma implementação ativa por objetivo.
Investigação e revisão independentes podem avançar em paralelo quando úteis.
Mais implementadores no mesmo objetivo exigem evoluir o fluxo, não contornar `claim`.

Uma tarefa pequena independente pode usar outra sessão, branch, worktree e PR.
Confirme a separação antes de escrever: iniciar um subagente não cria checkout.
Use a worktree gerenciada pelo cliente ou o procedimento da skill. Não reutilize
a worktree ativa de outro agente. Worktrees isolam arquivos em edição; banco,
portas e serviços externos precisam de separação própria quando forem usados.

Se duas tarefas alterarem contratos ou comportamento relacionados, coordene a
ordem de integração. Após uma mudança paralela ser integrada, atualize a base
conforme necessário e valide o conjunto antes de prosseguir. Preserve trabalho
não integrado e não apague worktrees ou diretórios automaticamente ao terminar.

## Qualidade e decisões

O implementador lê código, escreve e executa a validação relevante. O revisor
recebe spec, decisões, diff e evidências em uma sessão independente, sem o histórico
de raciocínio do autor. Retorne achados verificáveis; não corrija silenciosamente
durante a revisão. Outra sessão/modelo não equivale a uma identidade de aprovação
separada no GitHub: siga os requisitos do plugin para integração.

Planeje incrementalmente. Obtenha crítica independente quando o risco justificar,
especialmente em acesso, contratos públicos, dados e migrações. Registre divergências
e decisões; não convoque trio ou votação automaticamente. Fatos atuais exigem fontes.
Se nova evidência invalidar a spec, interrompa somente o trabalho dependente e trate
a decisão pelo fluxo do plugin. Escolhas locais e reparos rotineiros permanecem autônomos.

## Memória operacional

| Informação | Registro |
| --- | --- |
| Resultado e ordem do roadmap | Descrições das milestones e issues dos épicos. |
| Escopo, permissões e sequência de tarefas | Issue do objetivo e seu `Plan`. |
| Progresso, bloqueios e tentativas | Comentários da issue da tarefa. |
| Decisão humana material | Checkpoint conforme o contrato da skill. |
| Implementação e validação | Commits, PRs, checks e evidências vinculadas. |
| Decisão duradoura de produto/arquitetura | Documentação versionada quando útil. |

Antes de pausar, transferir responsabilidade ou concluir uma etapa, registre:
o que foi feito; links de evidência; validações e limitações; decisões e origem;
tentativas relevantes; próxima ação e bloqueio, se houver. Registre mudanças úteis,
sem repetir comentários de estado inalterado ou expor segredos e dados privados.

Revalide resumos de conversa e notas locais contra GitHub, Git e código atuais.
Não crie um MEMORY.md de tarefas por worktree. AGENTS.md, este guia e os perfis
contêm políticas estáveis, nunca diário de execução, filas duplicadas ou logs.

## Perfis e configuração

Os modelos e esforços ficam somente nos arquivos de [.codex/agents/](../.codex/agents/).
Perfis com modelo explícito o fixam quando selecionados; para mudar o modelo de um
papel, atualize o perfil por orientação do usuário. Todos respeitam as permissões
vigentes; padrões de sandbox não substituem as permissões efetivas do cliente/MCP.

Versione estes arquivos junto do projeto. Worktrees e outras máquinas precisam
partir de uma revisão que os contenha. Inicie uma nova sessão para carregar o
AGENTS.md atualizado e confirme que o cliente descobriu os perfis antes de usá-los.

Referências: [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[perfis de subagentes](https://learn.chatgpt.com/docs/agent-configuration/subagents)
e [worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees).
