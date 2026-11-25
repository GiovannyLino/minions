import 'server-only';
import * as client from 'openid-client';

/**
 * Cliente OIDC do BFF (Microsoft Entra ID em produção; IdP local em desenvolvimento).
 * Fluxo: Authorization Code + PKCE (S256) + state + nonce, cliente confidencial.
 * O access token da API fica apenas em cookie httpOnly — nunca chega ao JavaScript do navegador.
 */
export interface OidcSettings {
  issuer: URL;
  clientId: string;
  clientSecret: string;
  /** Escopos solicitados: OIDC + escopo delegado da API (ex.: api://minions-api/access_as_user). */
  scope: string;
  appUrl: URL;
}

export function oidcSettings(): OidcSettings | null {
  const { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_API_SCOPE, APP_URL } = process.env;
  if (!OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !OIDC_API_SCOPE || !APP_URL) return null;
  return {
    issuer: new URL(OIDC_ISSUER),
    clientId: OIDC_CLIENT_ID,
    clientSecret: OIDC_CLIENT_SECRET,
    scope: ['openid', 'profile', 'email', OIDC_API_SCOPE].join(' '),
    appUrl: new URL(APP_URL),
  };
}

let cached: { key: string; config: Promise<client.Configuration> } | null = null;

export async function oidcConfiguration(s: OidcSettings): Promise<client.Configuration> {
  const key = `${s.issuer}|${s.clientId}`;
  if (!cached || cached.key !== key) {
    // HTTP só é aceito para o IdP de desenvolvimento em loopback.
    const loopback = s.issuer.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(s.issuer.hostname);
    if (s.issuer.protocol !== 'https:' && !loopback) throw new Error('OIDC_ISSUER deve usar HTTPS');
    const config = client.discovery(s.issuer, s.clientId, s.clientSecret, undefined, loopback ? { execute: [client.allowInsecureRequests] } : undefined);
    cached = { key, config };
    config.catch(() => {
      cached = null;
    });
  }
  return cached.config;
}

export const redirectUri = (s: OidcSettings) => new URL('/auth/callback', s.appUrl).toString();

export const TX_COOKIE = 'minions_oidc_tx';

export interface OidcTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

/** Aceita apenas caminhos internos (evita open redirect). */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.startsWith('/auth/')) return '/';
  return value.slice(0, 512);
}

export const secureCookies = () => process.env.SESSION_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
