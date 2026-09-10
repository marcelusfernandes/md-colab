import { handleApi } from '@/lib/api-handler';
import { getRuntimeBindings } from 'virtual:md-colab-runtime-bindings';

export const dynamic = 'force-dynamic';
function handle(request: Request) {
  return handleApi(request, getRuntimeBindings());
}
export const GET = handle;
export const POST = handle;
export const DELETE = handle;
