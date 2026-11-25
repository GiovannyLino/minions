import { NextResponse, type NextRequest } from 'next/server';
import * as client from 'openid-client';
import { TX_COOKIE, oidcConfiguration, oidcSettings, safeReturnTo, secureCookies, type OidcTransaction } from '@/lib/oidc';
import { SESSION_COOKIE } from '@/lib/session';

export const dynamic = 'force-dynamic';

const MAX_SESSION_SECONDS = 8 * 3600;

/**
 * Retorno do IdP: valida state, nonce e PKCE, troca o código por tokens (cliente confidencial) e grava
 * apenas o access token da API em cookie httpOnly. O ID token é validado e descartado.
 */
export async function GET(request: NextRequest) {
  const settings = oidcSettings();
  if (!settings) return NextResponse.redirect(new URL('/login?error=sso_config', request.url));
  const fail = (reason: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${reason}`, settings.appUrl));
    res.cookies.set(TX_COOKIE, '', { path: '/auth/callback', maxAge: 0 });
    return res;
  };

  const raw = request.cookies.get(TX_COOKIE)?.value;
  let tx: OidcTransaction;
  try {
    tx = JSON.parse(Buffer.from(raw ?? '', 'base64url').toString('utf8')) as OidcTransaction;
    if (!tx.state || !tx.nonce || !tx.verifier) throw new Error();
  } catch {
    return fail('sso_expired');
  }
  if (request.nextUrl.searchParams.get('error')) return fail('sso_denied');

  // A URL atual é reconstruída a partir de APP_URL (não confiamos no Host recebido).
  const currentUrl = new URL(`/auth/callback${request.nextUrl.search}`, settings.appUrl);
  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    const config = await oidcConfiguration(settings);
    tokens = await client.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: tx.verifier, expectedState: tx.state, expectedNonce: tx.nonce, idTokenExpected: true });
  } catch {
    return fail('sso_failed');
  }
  if (!tokens.access_token) return fail('sso_failed');

  const res = NextResponse.redirect(new URL(safeReturnTo(tx.returnTo), settings.appUrl));
  res.headers.set('cache-control', 'no-store');
  res.cookies.set(TX_COOKIE, '', { path: '/auth/callback', maxAge: 0 });
  res.cookies.set(SESSION_COOKIE, tokens.access_token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax',
    path: '/',
    // A sessão do Minions nunca dura mais que o access token; ao expirar, o IdP renova via SSO.
    maxAge: Math.min(tokens.expires_in ?? 3600, MAX_SESSION_SECONDS),
  });
  return res;
}
