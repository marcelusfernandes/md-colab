import { AuthService, authConfig, validEmail } from './auth-service.ts';
import {
  DocumentService,
  HttpError,
  type CommentPageQuery,
  type ConversationFilter,
  type CursorPageQuery,
} from './document-service.ts';
import { ResendMailer, type Mailer } from './mailer.ts';
import { PublicationService } from './publication-service.ts';
import { WriteQuotaError } from './write-quotas.ts';

type DiagnosticMethod = 'GET' | 'POST' | 'DELETE' | 'OTHER';
type DiagnosticRoute =
  | 'access'
  | 'auth'
  | 'publications'
  | 'publishing_tokens'
  | 'session'
  | 'documents'
  | 'document'
  | 'comments'
  | 'conversations'
  | 'shares'
  | 'unknown';
type DiagnosticCategory =
  | 'unknown_route'
  | 'invalid_request'
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'quota'
  | 'rate_limit'
  | 'configuration'
  | 'unavailable'
  | 'internal';
type DiagnosticStatus =
  | 400
  | 401
  | 403
  | 404
  | 405
  | 409
  | 413
  | 415
  | 429
  | 500
  | 503;

function diagnosticMethod(method: string): DiagnosticMethod {
  return method === 'GET' || method === 'POST' || method === 'DELETE'
    ? method
    : 'OTHER';
}

function diagnosticRoute(request: Request): DiagnosticRoute {
  try {
    const parts = new URL(request.url).pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') return 'unknown';
    if (parts.length === 2 && parts[1] === 'access') return 'access';
    if (
      parts.length === 3 &&
      parts[1] === 'auth' &&
      ['test', 'request', 'verify', 'logout'].includes(parts[2])
    )
      return 'auth';
    if (parts.length === 2 && parts[1] === 'publications')
      return 'publications';
    if (
      parts[1] === 'publishing-tokens' &&
      (parts.length === 2 || parts.length === 3)
    )
      return 'publishing_tokens';
    if (parts.length === 2 && parts[1] === 'session') return 'session';
    if (parts[1] !== 'documents') return 'unknown';
    if (parts.length === 2) return 'documents';
    if (parts.length === 3) return 'document';
    if (parts[3] === 'comments' && (parts.length === 4 || parts.length === 5))
      return 'comments';
    if (
      (parts[3] === 'conversations' && parts.length >= 4 && parts.length <= 7) ||
      (parts[3] === 'conversation-changes' && parts.length === 4)
    )
      return 'conversations';
    if (parts[3] === 'shares' && parts.length === 4) return 'shares';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function diagnosticStatus(error: unknown): DiagnosticStatus {
  const status =
    error instanceof HttpError || error instanceof WriteQuotaError
      ? error.status
      : 500;
  return [400, 401, 403, 404, 405, 409, 413, 415, 429, 500, 503].includes(
    status,
  )
    ? (status as DiagnosticStatus)
    : 500;
}

function diagnosticCategory(
  error: unknown,
  route: DiagnosticRoute,
  status: DiagnosticStatus,
): DiagnosticCategory {
  if (route === 'unknown') return 'unknown_route';
  if (error instanceof WriteQuotaError)
    return error.code === 'quota_exceeded' ? 'quota' : 'configuration';
  if (status === 400 || status === 413 || status === 415)
    return 'invalid_request';
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not_found';
  if (status === 405) return 'method_not_allowed';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limit';
  if (status === 503) return 'unavailable';
  return 'internal';
}

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

function cursorPageQuery(
  parameters: URLSearchParams,
  collection: 'documentos' | 'convidados',
): CursorPageQuery {
  const keys = [...parameters.keys()];
  if (
    keys.some((key) => key !== 'cursor') ||
    parameters.getAll('cursor').length > 1
  )
    throw new HttpError(400, `Parâmetros de ${collection} inválidos.`);
  const cursor = parameters.get('cursor');
  return cursor === null ? {} : { cursor };
}

function conversationPageQuery(parameters: URLSearchParams) {
  const keys = [...parameters.keys()];
  if (
    keys.some((key) => key !== 'filter' && key !== 'cursor') ||
    parameters.getAll('filter').length > 1 ||
    parameters.getAll('cursor').length > 1
  )
    throw new HttpError(400, 'Parâmetros de conversas inválidos.');
  const filter = parameters.get('filter') ?? 'all';
  if (!['all', 'open', 'unanswered', 'closed'].includes(filter))
    throw new HttpError(400, 'Filtro de conversas inválido.');
  const cursor = parameters.get('cursor');
  return {
    filter: filter as ConversationFilter,
    ...(cursor === null ? {} : { cursor }),
  };
}

function oneCursorQuery(parameters: URLSearchParams, label: string) {
  const keys = [...parameters.keys()];
  if (
    keys.some((key) => key !== 'cursor') ||
    parameters.getAll('cursor').length > 1
  )
    throw new HttpError(400, `Parâmetros de ${label} inválidos.`);
  return parameters.get('cursor') ?? undefined;
}

function conversationChangesQuery(parameters: URLSearchParams) {
  const keys = [...parameters.keys()];
  if (
    keys.some((key) => key !== 'after') ||
    parameters.getAll('after').length !== 1
  )
    throw new HttpError(400, 'Parâmetros de mudanças de conversas inválidos.');
  return parameters.get('after')!;
}

export async function handleApi(
  request: Request,
  values: Cloudflare.Env,
  mailer?: Mailer,
) {
  const route = diagnosticRoute(request);
  try {
    const config = authConfig(values);
    const configuredMailer =
      mailer ?? new ResendMailer(values.RESEND_API_KEY, values.MAIL_FROM);
    const auth = new AuthService(values.DB, config, configuredMailer);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\//, '').split('/');
    const publishing = new PublicationService(
      values.DB,
      config,
      undefined,
      values,
    );
    if (path[0] === 'access' && path.length === 1 && request.method === 'GET')
      return json({
        mode: config.testMode ? 'test' : 'email',
        authorMode: config.authorMode ?? 'allowlist',
      });
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
    const service = new DocumentService(values.DB, viewer, values);
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
    if (path[0] !== 'documents' || path.length > 6)
      throw new HttpError(404, 'Página não encontrada.');
    const [, id, action, resourceId, subresource, eventId] = path;
    if (resourceId && action === 'comments' && request.method !== 'GET')
      throw new HttpError(404, 'Página não encontrada.');
    if (request.method === 'GET') {
      if (!id)
        return json(
          await service.list(cursorPageQuery(url.searchParams, 'documentos')),
        );
      if (!action) {
        const document = await service.document(id);
        const commentPage = await service.comments(id);
        return json({
          document,
          ...commentPage,
          isOwner: document.owner_id === viewer.id,
        });
      }
      if (action === 'comments' && resourceId && !subresource)
        return json({ comment: await service.comment(id, resourceId) });
      if (
        action === 'comments' &&
        resourceId &&
        subresource === 'context' &&
        !eventId
      ) {
        if ([...url.searchParams.keys()].length > 0)
          throw new HttpError(400, 'Parâmetros de contexto inválidos.');
        return json(await service.commentContext(id, resourceId));
      }
      if (action === 'comments' && !resourceId)
        return json(
          await service.comments(id, commentPageQuery(url.searchParams)),
        );
      if (action === 'conversations' && !resourceId)
        return json(
          await service.conversations(id, conversationPageQuery(url.searchParams)),
        );
      if (action === 'conversations' && resourceId && !subresource)
        return json({
          conversation: await service.conversationState(id, resourceId),
        });
      if (action === 'conversation-changes' && !resourceId)
        return json(
          await service.conversationChanges(
            id,
            conversationChangesQuery(url.searchParams),
          ),
        );
      if (action === 'conversations' && resourceId && subresource === 'replies' && !eventId)
        return json(
          await service.conversationReplies(
            id,
            resourceId,
            oneCursorQuery(url.searchParams, 'respostas'),
          ),
        );
      if (action === 'conversations' && resourceId && subresource === 'events') {
        if (eventId)
          return json({
            event: await service.conversationEvent(id, resourceId, eventId),
          });
        return json(
          await service.conversationEvents(
            id,
            resourceId,
            oneCursorQuery(url.searchParams, 'histórico'),
          ),
        );
      }
      if (action === 'shares' && !resourceId)
        return json(
          await service.shares(
            id,
            cursorPageQuery(url.searchParams, 'convidados'),
          ),
        );
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
      if (action === 'comments' && !resourceId)
        return json({ comment: await service.addComment(id, input) }, 201);
      if (
        action === 'conversations' &&
        resourceId &&
        subresource === 'events' &&
        !eventId
      ) {
        const result = await service.addConversationEvent(id, resourceId, input);
        return json({ event: result.event }, result.replayed ? 200 : 201);
      }
      if (action === 'shares' && !resourceId) {
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
        const share = await service.share(id, input);
        try {
          await auth.invite(email, id, viewer.id);
          return json({ share, emailSubmitted: true });
        } catch (error) {
          return json({
            share,
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
      return json({ revokedEmail: await service.revoke(id, input.email) });
    throw new HttpError(405, 'Ação indisponível.');
  } catch (error) {
    const requestId = crypto.randomUUID();
    const status = diagnosticStatus(error);
    console.error(
      'api_failure',
      JSON.stringify({
        requestId,
        method: diagnosticMethod(request.method),
        route,
        category: diagnosticCategory(error, route, status),
        status,
      }),
    );
    if (error instanceof HttpError || error instanceof WriteQuotaError)
      return json(
        {
          error: error.message,
          ...('code' in error ? { code: error.code } : {}),
          requestId,
        },
        status,
      );
    return json(
      {
        error: 'Não foi possível concluir. Tente novamente.',
        requestId,
      },
      500,
    );
  }
}
