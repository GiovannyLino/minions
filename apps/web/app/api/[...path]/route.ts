import { cookies } from 'next/headers';
import { after, type NextRequest } from 'next/server';
import { callApi } from '@/lib/api-transport';
import { clientIpFrom } from '@/lib/client-ip';
import { drainInBackground, isEmbedded } from '@/lib/embedded';
import { SESSION_COOKIE } from '@/lib/session';

/**
 * BFF: o navegador fala apenas com esta rota (mesma origem, cookie httpOnly).
 * - Destino fixo (API_URL ou API embutida) e somente caminhos /v1/* — o cliente não escolhe o host.
 * - Converte o cookie de sessão em Authorization: Bearer; não repassa cookies nem outros headers.
 * - Bloqueia requisições de outra origem em métodos que alteram estado (CSRF).
 * - Faz streaming do corpo (SSE do chat, uploads e downloads).
 */
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'x-request-id'];
const FORWARD_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'cache-control', 'retry-after', 'x-request-id', 'x-content-type-options'];

async function handle(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path[0] !== 'v1' || path.some((s) => !SEGMENT.test(s) || s === '..' || s === '.')) {
    return Response.json({ error: { code: 'not_found', message: 'Rota não encontrada' } }, { status: 404 });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Compara só o host: atrás de um túnel/proxy HTTPS o esquema interno é http.
    const origin = request.headers.get('origin');
    let originHost: string | null = null;
    try {
      originHost = origin ? new URL(origin).host : null;
    } catch {
      originHost = 'invalid';
    }
    if (origin && originHost !== (request.headers.get('x-forwarded-host') ?? request.headers.get('host'))) {
      return Response.json({ error: { code: 'forbidden', message: 'Origem não permitida' } }, { status: 403 });
    }
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return Response.json({ error: { code: 'unauthorized', message: 'Autenticação necessária' } }, { status: 401 });

  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('x-forwarded-for', clientIpFrom(request.headers));

  let upstream: Response;
  try {
    upstream = await callApi(`/${path.join('/')}${request.nextUrl.search}`, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'error',
      cache: 'no-store',
      signal: request.signal,
      // Necessário para enviar corpo em streaming no fetch do Node.
      duplex: 'half',
    });
  } catch (err) {
    console.error('[minions] API indisponível:', (err as Error).message);
    return Response.json({ error: { code: 'bad_gateway', message: 'Serviço do Minions indisponível no momento' } }, { status: 502 });
  }

  const out = new Headers();
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (upstream.headers.get('content-type')?.includes('text/event-stream')) {
    out.set('cache-control', 'no-cache, no-transform');
    out.set('x-accel-buffering', 'no');
  }
  // Sem worker permanente na Vercel: novos uploads são indexados logo após a resposta.
  if (isEmbedded() && upstream.ok && request.method === 'POST' && path[1] === 'documents') after(() => drainInBackground());
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const dynamic = 'force-dynamic';
// Chat (várias chamadas ao Gemini) e indexação de documentos precisam de mais que o padrão.
export const maxDuration = 60;
