import { NextResponse, type NextRequest } from 'next/server';
import { DEMO_COOKIE, demoCode, isDemoTokenValid } from './lib/demo-gate';

/**
 * Portão da demonstração pública (Next 16 "proxy", runtime Node).
 * Sem DEMO_ACCESS_CODE configurado, não faz nada (uso local).
 * As ações do servidor também verificam o portão — o proxy não é a única barreira.
 */
export function proxy(request: NextRequest) {
  if (!demoCode() || isDemoTokenValid(request.cookies.get(DEMO_COOKIE)?.value)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return Response.json({ error: { code: 'demo_locked', message: 'Código de acesso necessário' } }, { status: 401 });
  }
  // Atrás do túnel HTTPS o servidor recebe http; usa o esquema/host públicos informados pelo proxy.
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || request.nextUrl.protocol.replace(':', '');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host;
  const target = new URL('/acesso', `${proto === 'https' ? 'https' : 'http'}://${host}`);
  target.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  const res = NextResponse.redirect(target, 307);
  res.headers.set('cache-control', 'no-store');
  return res;
}

export const config = {
  matcher: ['/((?!acesso|_next/static|_next/image|favicon.ico).*)'],
};
