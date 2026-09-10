import { getRuntimeBindings } from 'virtual:md-colab-runtime-bindings';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const result = await getRuntimeBindings()
      .DB.prepare('SELECT 1 AS ready')
      .first<{ ready: number }>();
    if (result?.ready !== 1) throw new Error('Unexpected readiness result.');
    return Response.json(
      { status: 'ready' },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { status: 'unavailable' },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
