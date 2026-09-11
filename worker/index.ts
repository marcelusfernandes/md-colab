import handler from 'vinext/server/fetch-handler';
import { drainNotifications } from '../lib/notification-outbox.ts';

export default {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    return handler.fetch(request, env, ctx);
  },
  async scheduled(
    _controller: ScheduledController,
    env: Cloudflare.Env,
    _ctx: ExecutionContext,
  ) {
    await drainNotifications(env);
  },
};
