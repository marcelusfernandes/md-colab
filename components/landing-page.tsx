import {
  ArrowRight,
  Check,
  FileText,
  LockKeyhole,
  MessageSquareText,
} from 'lucide-react';

const workspaceHref = '/documentos';

export function LandingPage() {
  return (
    <div className="landing-shell">
      <a className="landing-skip" href="#conteudo">
        Pular para o conteúdo
      </a>

      <header className="landing-header">
        {/* oxlint-disable-next-line next/no-html-link-for-pages -- Native navigation is compatible with the Vinext runtime. */}
        <a className="landing-brand" href="/" aria-label="md-colab — início">
          <span aria-hidden="true">md</span>
          <strong>colab</strong>
        </a>
        <nav className="landing-nav" aria-label="Acesso">
          <a className="landing-login" href={workspaceHref}>
            Entrar
          </a>
          <a
            className="landing-button landing-button-small"
            href={workspaceHref}
          >
            Criar um plano
          </a>
        </nav>
      </header>

      <main id="conteudo">
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">Markdown + crítica humana</p>
            <h1 id="landing-title">
              Um plano melhor antes do próximo comando.
            </h1>
            <p className="landing-intro">
              Compartilhe planos Markdown produzidos com agentes, convide as
              pessoas certas para comentar e leve as decisões de volta ao seu
              fluxo. A execução continua nas mãos do autor.
            </p>
            <div className="landing-actions">
              <a className="landing-button" href={workspaceHref}>
                Criar um plano <ArrowRight size={18} aria-hidden="true" />
              </a>
              <a className="landing-text-link" href="#como-funciona">
                Ver como funciona
              </a>
            </div>
            <ul
              className="landing-assurances"
              aria-label="Como o acesso funciona"
            >
              <li>
                <Check size={15} aria-hidden="true" /> E-mail verificado
              </li>
              <li>
                <LockKeyhole size={15} aria-hidden="true" /> Privado por convite
              </li>
            </ul>
          </div>

          <article
            className="landing-preview"
            aria-label="Exemplo ilustrativo de plano e crítica"
          >
            <header className="landing-preview-bar">
              <div aria-hidden="true">
                <span className="landing-window-dot" />
                <span className="landing-window-dot" />
                <span className="landing-window-dot" />
              </div>
              <span>plano-de-migracao.md</span>
              <span className="landing-example-badge">Exemplo</span>
            </header>

            <div className="landing-preview-body">
              <div className="landing-markdown" aria-label="Trecho do plano">
                <p className="landing-code-heading">
                  <span>#</span> Migração do índice
                </p>
                <p>
                  <span className="landing-line-number">01</span> Preservar a
                  busca durante a transição.
                </p>
                <p>
                  <span className="landing-line-number">02</span>{' '}
                  <span className="landing-checkbox">[ ]</span> Criar snapshot
                  antes da troca
                </p>
                <p className="landing-annotated-line">
                  <span className="landing-line-number">03</span>{' '}
                  <span className="landing-checkbox">[ ]</span> Ativar o novo
                  índice em produção
                  <span className="landing-comment-pin" aria-hidden="true">
                    1
                  </span>
                </p>
                <p>
                  <span className="landing-line-number">04</span>{' '}
                  <span className="landing-checkbox">[ ]</span> Medir resultados
                  por 30 minutos
                </p>
              </div>

              <section
                className="landing-comment"
                aria-label="Crítica no exemplo"
              >
                <div className="landing-comment-heading">
                  <span className="landing-avatar" aria-hidden="true">
                    M
                  </span>
                  <p>
                    <strong>Marina</strong>
                    <span>Crítica humana · exemplo</span>
                  </p>
                  <MessageSquareText size={17} aria-hidden="true" />
                </div>
                <blockquote>
                  “Antes de ativar, podemos definir o sinal de rollback e quem
                  acompanha a janela?”
                </blockquote>
              </section>

              <section
                className="landing-decision"
                aria-label="Retorno da crítica ao fluxo local no exemplo"
              >
                <span>De volta ao fluxo local</span>
                <p>
                  <ArrowRight size={16} aria-hidden="true" /> O autor leva a
                  crítica para revisar o plano
                </p>
              </section>
            </div>
            <footer>Nenhum dado real é exibido neste exemplo.</footer>
          </article>
        </section>

        <section
          className="landing-process"
          id="como-funciona"
          aria-labelledby="process-title"
        >
          <div className="landing-section-heading">
            <p className="landing-eyebrow">Um fluxo curto e explícito</p>
            <h2 id="process-title">
              Do Markdown à decisão, sem tirar o autor do comando.
            </h2>
          </div>

          <ol className="landing-steps">
            <li>
              <span className="landing-step-number">01</span>
              <FileText size={24} aria-hidden="true" />
              <h3>Publique o plano</h3>
              <p>
                Importe um arquivo Markdown autocontido e preserve o texto que
                saiu do seu fluxo com agentes.
              </p>
            </li>
            <li>
              <span className="landing-step-number">02</span>
              <MessageSquareText size={24} aria-hidden="true" />
              <h3>Convide a crítica</h3>
              <p>
                Compartilhe com e-mails específicos. Cada pessoa recebe acesso
                para ler e comentar aquele plano.
              </p>
            </li>
            <li>
              <span className="landing-step-number">03</span>
              <ArrowRight size={24} aria-hidden="true" />
              <h3>Retome a decisão</h3>
              <p>
                Avalie comentários e divergências, ajuste seu plano e decida se
                e como ele será executado localmente.
              </p>
            </li>
          </ol>
        </section>

        <section
          className="landing-principle"
          aria-labelledby="principle-title"
        >
          <div>
            <p className="landing-eyebrow">Responsabilidade preservada</p>
            <h2 id="principle-title">Crítica é contexto. O autor decide.</h2>
            <p>
              Comentários ajudam a revelar lacunas antes da execução. Encerrar
              uma conversa não aprova mudanças nem dispara comandos.
            </p>
          </div>
          <aside
            className="landing-private-card"
            aria-label="Privacidade dos planos"
          >
            <LockKeyhole size={25} aria-hidden="true" />
            <div>
              <h3>Seus planos não ficam públicos.</h3>
              <p>
                Entre por um link enviado ao seu e-mail. Cada plano é privado e
                só pode ser aberto pelo autor ou por quem recebeu convite.
              </p>
            </div>
          </aside>
        </section>

        <section className="landing-closing" aria-labelledby="closing-title">
          <p className="landing-eyebrow">Pronto para a próxima crítica?</p>
          <h2 id="closing-title">Traga seu Markdown.</h2>
          <p>Confirme seu e-mail e publique seu primeiro plano privado.</p>
          <a className="landing-button" href={workspaceHref}>
            Criar um plano <ArrowRight size={18} aria-hidden="true" />
          </a>
        </section>
      </main>

      <footer className="landing-footer">
        {/* oxlint-disable-next-line next/no-html-link-for-pages -- Native navigation is compatible with the Vinext runtime. */}
        <a className="landing-brand landing-brand-footer" href="/">
          <span aria-hidden="true">md</span>
          <strong>colab</strong>
        </a>
        <p>Planos Markdown com espaço para crítica humana.</p>
        <a href={workspaceHref}>Entrar</a>
      </footer>
    </div>
  );
}
