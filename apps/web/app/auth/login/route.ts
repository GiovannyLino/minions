import { NextResponse, type NextRequest } from 'next/server';
import * as client from 'openid-client';
import { TX_COOKIE, oidcConfiguration, oidcSettings, redirectUri, safeReturnTo, secureCookies, type OidcTransaction } from '@/lib/oidc';

export const dynamic = 'force-dynamic';

/** Inicia o login corporativo: gera state, nonce e PKCE e redireciona ao IdP. */
export async function GET(request: NextRequest) {
  const settings = oidcSettings();
  if (!settings) return NextResponse.redirect(new URL('/login?error=sso_config', request.url));
  let config: client.Configuration;
  try {
    config = await oidcConfiguration(settings);
  } catch {
    return NextResponse.redirect(new URL('/login?error=sso_unavailable', settings.appUrl));
  }
  const tx: OidcTransaction = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    verifier: client.randomPKCECodeVerifier(),
    returnTo: safeReturnTo(request.nextUrl.searchParams.get('returnTo')),
  };
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(settings),
    scope: settings.scope,
    response_type: 'code',
    response_mode: 'query',
    code_challenge: await client.calculatePKCECodeChallenge(tx.verifier),
    code_challenge_method: 'S256',
    state: tx.state,
    nonce: tx.nonce,
  });
  const res = NextResponse.redirect(url);
  res.headers.set('cache-control', 'no-store');
  // Transação de curta duração, restrita ao callback.
  res.cookies.set(TX_COOKIE, Buffer.from(JSON.stringify(tx)).toString('base64url'), {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax',
    path: '/auth/callback',
    maxAge: 600,
  });
  return res;
}
