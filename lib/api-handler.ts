import { AuthService, authConfig, validEmail } from './auth-service.ts';
import {
  DocumentService,
  HttpError,
  type CommentPageQuery,
} from './document-service.ts';
import { ResendMailer, type Mailer } from './mailer.ts';
import { PublicationService } from './publication-service.ts';

export function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    },
  });
}

async function inputFrom(request: Request, maximum: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Solicitação inválida.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new HttpError(413, 'A solicitação é muito grande.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const input = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error();
    return input as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Solicitação inválida.');
  }
}

function commentPageQuery(parameters: URLSearchParams): CommentPageQuery {
  const keys = [...parameters.keys()];
  if (
    keys.some((key) => key !== 'before' && key !== 'after') ||
    parameters.getAll('before').length > 1 ||
    parameters.getAll('after').length > 1
  )
    throw new HttpError(400, 'Parâmetros de comentários inválidos.');
  const before = parameters.get('before');
  const after = parameters.get('after');
  if (before !== null && after !== null)
    throw new HttpError(400, 'Use apenas um cursor de comentários.');
  return {
    ...(before === null ? {} : { before }),
    ...(after === null ? {} : { after }),
  };
}

export async function handleApi(
  request: Request,
  values: Cloudflare.Env,
  mailer?: Mailer,
) {
  try {
    const config = authConfig(values);
    const configuredMailer =
      mailer ?? new ResendMailer(values.RESEND_API_KEY, values.MAIL_FROM);
    const auth = new AuthService(values.DB, config, configuredMailer);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\//, '').split('/');
    const publishing = new PublicationService(values.DB, config);
    if (path[0] === 'access' && path.length === 1 && request.method === 'GET')
      return json({ mode: config.testMode ? 'test' : 'email' });
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin');
      if (
        (origin && origin !== config.origin) ||
        request.headers.get('sec-fetch-site') === 'cross-site'
      )
        throw new HttpError(403, 'Origem da solicitação inválida.');
      if (
        request.headers.get('content-type')?.split(';')[0].trim() !==
        'application/json'
      )
        throw new HttpError(415, 'Use JSON nesta solicitação.');
    }
    if (path[0] === 'auth' && path.length === 2 && request.method === 'POST') {
      const input = await inputFrom(request, 4096);
      const ip = request.headers.get('cf-connecting-ip') ?? 'unavailable';
      if (path[1] === 'test') {
        if (!config.testMode)
          throw new HttpError(404, 'Acesso de teste indisponível.');
        await auth.limit('test-entry', ip, 60, 900);
        const result = await auth.enterTest(input, request);
        return json({ redirect: result.redirect }, 200, {
          'Set-Cookie': auth.cookie(result.session),
        });
      }
      if (config.testMode && path[1] !== 'logout')
        throw new HttpError(
          404,
          'Neste teste, entre apenas informando seu e-mail.',
        );
      if (path[1] === 'request') return json(await auth.requestLink(input, ip));
      if (path[1] === 'verify') {
        await auth.limit('verify-ip', ip, 30, 900);
        const result = await auth.redeem(input.token);
        await auth.logout(request);
        return json({ redirect: result.redirect }, 200, {
          'Set-Cookie': auth.cookie(result.session),
        });
      }
      if (path[1] === 'logout') {
        await auth.logout(request);
        return json({ ok: true }, 200, { 'Set-Cookie': auth.cookie('', true) });
      }
      throw new HttpError(404, 'Página não encontrada.');
    }
    if (
      path[0] === 'publications' &&
      path.length === 1 &&
      request.method === 'POST'
    ) {
      if (config.testMode)
        throw new HttpError(404, 'Publicação por API indisponível.');
      const credential = await publishing.authenticate(request);
      if (!auth.canCreate(credential.viewer))
        throw new HttpError(
          403,
          'Sua conta não está habilitada para publicar documentos.',
        );
      const input = await inputFrom(request, 2 * 1024 * 1024);
      return json(
        await publishing.publish(
          credential.viewer,
          credential.credentialId,
          input,
          request.headers.get('idempotency-key'),
        ),
        201,
      );
    }
    const viewer = await auth.viewer(request);
    if (!viewer)
      throw new HttpError(
        401,
        'Entre com seu e-mail para acessar os documentos.',
      );
    const service = new DocumentService(values.DB, viewer);
    if (path[0] === 'session' && path.length === 1 && request.method === 'GET')
      return json({ viewer, canCreate: auth.canCreate(viewer) });
    if (path[0] === 'publishing-tokens' && path.length <= 2) {
      if (config.testMode || viewer.isTest)
        throw new HttpError(404, 'Credenciais de publicação indisponíveis.');
      const [, id] = path;
      if (request.method === 'GET' && !id)
        return json({ credentials: await publishing.credentials(viewer) });
      if (request.method === 'POST' && !id) {
        if (!auth.canCreate(viewer))
          throw new HttpError(
            403,
            'Sua conta não está habilitada para criar credenciais.',
          );
        await auth.limit(
          'publishing-token-create',
          viewer.id,
          20,
          24 * 60 * 60,
        );
        return json(
          await publishing.createCredential(
            viewer,
            await inputFrom(request, 4096),
          ),
          201,
        );
      }
      if (request.method === 'DELETE' && id)
        return json({
          credential: await publishing.revokeCredential(viewer, id),
        });
      throw new HttpError(405, 'Ação indisponível.');
    }
    if (path[0] !== 'documents' || path.length > 4)
      throw new HttpError(404, 'Página não encontrada.');
    const [, id, action, resourceId] = path;
    if (resourceId && !(request.method === 'GET' && action === 'comments'))
      throw new HttpError(404, 'Página não encontrada.');
    if (request.method === 'GET') {
      if (!id) return json({ documents: await service.list() });
      if (!action) {
        const document = await service.document(id);
        const commentPage = await service.comments(id);
        return json({
          document,
          ...commentPage,
          isOwner: document.owner_id === viewer.id,
        });
      }
      if (action === 'comments' && resourceId)
        return json({ comment: await service.comment(id, resourceId) });
      if (action === 'comments')
        return json(
          await service.comments(id, commentPageQuery(url.searchParams)),
        );
      if (action === 'shares' && !resourceId)
        return json({ shares: await service.shares(id) });
      throw new HttpError(404, 'Página não encontrada.');
    }
    const input = await inputFrom(request, 2 * 1024 * 1024);
    if (request.method === 'POST') {
      if (!id) {
        if (!auth.canCreate(viewer))
          throw new HttpError(
            403,
            'Sua conta pode ler e comentar os documentos recebidos.',
          );
        const document = await service.create(input);
        const currentAuth = new AuthService(
          values.DB,
          authConfig(values),
          configuredMailer,
        );
        const currentViewer = await currentAuth.viewer(request);
        if (
          !currentViewer ||
          currentViewer.id !== viewer.id ||
          Boolean(currentViewer.isTest) !== Boolean(viewer.isTest) ||
          !currentAuth.canCreate(currentViewer)
        )
          throw new HttpError(
            403,
            'Sua conta não está mais habilitada para importar este documento.',
          );
        return json({ document }, 201);
      }
      if (action === 'comments')
        return json({ comment: await service.addComment(id, input) }, 201);
      if (action === 'shares') {
        await service.document(id, true);
        if (viewer.isTest)
          throw new HttpError(
            405,
            'Neste teste, compartilhe copiando o link do documento.',
          );
        const email = validEmail(input.email);
        if (email === viewer.email)
          throw new HttpError(400, 'Você já tem acesso como dono.');
        auth.assertMailConfigured();
        const shares = await service.share(id, input);
        try {
          await auth.invite(email, id, viewer.id);
          return json({ shares, emailSubmitted: true });
        } catch (error) {
          return json({
            shares,
            emailSubmitted: false,
            emailError:
              error instanceof HttpError
                ? error.message
                : 'Não foi possível confirmar o envio do convite.',
          });
        }
      }
    }
    if (
      request.method === 'DELETE' &&
      id &&
      action === 'shares' &&
      typeof input.email === 'string'
    )
      return json({ shares: await service.revoke(id, input.email) });
    throw new HttpError(405, 'Ação indisponível.');
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    console.error(
      'Falha ao acessar os documentos:',
      error instanceof Error ? error.name : 'UnknownError',
    );
    return json({ error: 'Não foi possível concluir. Tente novamente.' }, 500);
  }
}
