/**
 * Provedor OIDC de DESENVOLVIMENTO que imita o formato dos tokens do Microsoft Entra ID
 * (v2: `oid`, `preferred_username`, `scp`, `roles`, `groups` como objectIds).
 * Serve para testar localmente o fluxo Authorization Code + PKCE sem um tenant real.
 * Nunca use em produção: identidades fictícias, chave efêmera, sem senha.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

export const MOCK_GROUPS = {
  ti: '11111111-0000-4000-8000-000000000001',
  comercial: '11111111-0000-4000-8000-000000000002',
  engenharia: '11111111-0000-4000-8000-000000000003',
  financeiro: '11111111-0000-4000-8000-000000000004',
} as const;

export const MOCK_GROUP_MAP = Object.fromEntries(Object.entries(MOCK_GROUPS).map(([name, id]) => [id, name]));

export const MOCK_IDENTITIES = [
  { oid: 'a0000000-0000-4000-8000-000000000001', name: 'Ana Ribeiro', email: 'ana.ribeiro@sso.exemplo.test', roles: ['Minions.Admin'], groups: [MOCK_GROUPS.ti] },
  { oid: 'a0000000-0000-4000-8000-000000000002', name: 'Marcos Lima', email: 'marcos.lima@sso.exemplo.test', roles: ['Minions.Manager'], groups: [MOCK_GROUPS.comercial] },
  { oid: 'a0000000-0000-4000-8000-000000000003', name: 'Carla Souza', email: 'carla.souza@sso.exemplo.test', roles: [], groups: [MOCK_GROUPS.engenharia] },
  { oid: 'a0000000-0000-4000-8000-000000000004', name: 'Diego Martins', email: 'diego.martins@sso.exemplo.test', roles: [], groups: [MOCK_GROUPS.financeiro] },
] as const;

export interface MockOidcOptions {
  port: number;
  clientId: string;
  clientSecret: string;
  apiAudience: string;
  apiScope?: string;
}

export interface MockOidc {
  issuer: string;
  jwksUri: string;
  server: Server;
  /** Emite um access token diretamente (para testes automatizados). */
  mintAccessToken(identity: (typeof MOCK_IDENTITIES)[number], overrides?: Record<string, unknown>, opts?: { audience?: string; expiresIn?: string }): Promise<string>;
  close(): Promise<void>;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function startMockOidc(opts: MockOidcOptions): Promise<MockOidc> {
  if (process.env.NODE_ENV === 'production') throw new Error('Mock OIDC é proibido em produção');
  const issuer = `http://127.0.0.1:${opts.port}`;
  const apiScope = opts.apiScope ?? 'access_as_user';
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const kid = randomUUID();
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { identity: (typeof MOCK_IDENTITIES)[number]; redirectUri: string; challenge: string; nonce: string | null; scope: string; exp: number }>();

  const sign = (claims: Record<string, unknown>, audience: string, expiresIn = '1h') =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expiresIn).sign(privateKey);

  const mintAccessToken: MockOidc['mintAccessToken'] = (identity, overrides = {}, o = {}) =>
    sign({ sub: identity.oid, oid: identity.oid, tid: 'mock-tenant', name: identity.name, preferred_username: identity.email, scp: apiScope, roles: identity.roles, groups: identity.groups, ver: '2.0', ...overrides }, o.audience ?? opts.apiAudience, o.expiresIn);

  const send = (res: ServerResponse, status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<URLSearchParams>((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(new URLSearchParams(data)));
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    try {
      if (url.pathname === '/.well-known/openid-configuration') {
        return send(res, 200, JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/logout`,
          response_types_supported: ['code'],
          subject_types_supported: ['pairwise'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        }));
      }
      if (url.pathname === '/jwks') return send(res, 200, JSON.stringify({ keys: [jwk] }));

      if (url.pathname === '/authorize' && req.method === 'GET') {
        const p = url.searchParams;
        if (p.get('client_id') !== opts.clientId || p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
          return send(res, 400, 'Requisição de autorização inválida (client_id, response_type=code e PKCE S256 são obrigatórios)', 'text/plain; charset=utf-8');
        }
        const hidden = ['redirect_uri', 'state', 'nonce', 'code_challenge', 'scope'].map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(p.get(k) ?? '')}">`).join('');
        const buttons = MOCK_IDENTITIES.map((i) => `<button name="oid" value="${i.oid}"><b>${escapeHtml(i.name)}</b><span>${escapeHtml(i.email)} · ${escapeHtml(i.roles.join(', ') || 'sem app role')}</span></button>`).join('');
        return send(res, 200, `<!doctype html><meta charset="utf-8"><title>IdP de desenvolvimento</title>
<style>body{font:14px system-ui;background:#f3f3f1;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #ddd;border-radius:14px;padding:24px;width:360px}h1{font-size:16px;margin:0 0 4px}p{color:#666;margin:0 0 16px;font-size:12.5px}button{display:block;width:100%;text-align:left;border:1px solid #e3e3e0;background:#fff;border-radius:10px;padding:10px 12px;margin:6px 0;cursor:pointer}button:hover{background:#f6f6f4}span{display:block;color:#777;font-size:12px}</style>
<main><h1>IdP de desenvolvimento (simula o Entra ID)</h1><p>Identidades fictícias · não use em produção</p><form method="post" action="/authorize">${hidden}${buttons}</form></main>`, 'text/html; charset=utf-8');
      }

      if (url.pathname === '/authorize' && req.method === 'POST') {
        const b = await readBody(req);
        const identity = MOCK_IDENTITIES.find((i) => i.oid === b.get('oid'));
        const redirectUri = b.get('redirect_uri') ?? '';
        if (!identity || !redirectUri.startsWith('http://localhost') && !redirectUri.startsWith('http://127.0.0.1')) return send(res, 400, 'invalid', 'text/plain');
        const code = randomBytes(24).toString('base64url');
        codes.set(code, { identity, redirectUri, challenge: b.get('code_challenge') ?? '', nonce: b.get('nonce') || null, scope: b.get('scope') ?? '', exp: Date.now() + 60_000 });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        if (b.get('state')) target.searchParams.set('state', b.get('state')!);
        target.searchParams.set('iss', issuer);
        res.writeHead(302, { location: target.toString() });
        return res.end();
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        const b = await readBody(req);
        let clientId = b.get('client_id');
        let clientSecret = b.get('client_secret');
        const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : null;
        if (basic) [clientId, clientSecret] = basic.split(':').map(decodeURIComponent) as [string, string];
        if (clientId !== opts.clientId || clientSecret !== opts.clientSecret) return send(res, 401, JSON.stringify({ error: 'invalid_client' }));
        const entry = codes.get(b.get('code') ?? '');
        codes.delete(b.get('code') ?? '');
        const verifier = b.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (!entry || entry.exp < Date.now() || entry.redirectUri !== b.get('redirect_uri') || entry.challenge !== challenge) {
          return send(res, 400, JSON.stringify({ error: 'invalid_grant' }));
        }
        const i = entry.identity;
        const idToken = await sign({ sub: i.oid, oid: i.oid, tid: 'mock-tenant', name: i.name, preferred_username: i.email, email: i.email, ...(entry.nonce ? { nonce: entry.nonce } : {}), ver: '2.0' }, opts.clientId);
        return send(res, 200, JSON.stringify({ token_type: 'Bearer', expires_in: 3600, scope: entry.scope, id_token: idToken, access_token: await mintAccessToken(i) }));
      }

      if (url.pathname === '/logout') {
        const back = url.searchParams.get('post_logout_redirect_uri');
        res.writeHead(302, { location: back && /^http:\/\/(localhost|127\.0\.0\.1)/.test(back) ? back : '/' });
        return res.end();
      }
      send(res, 404, '{"error":"not_found"}');
    } catch {
      send(res, 500, '{"error":"server_error"}');
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  const realIssuer = `http://127.0.0.1:${port}`;
  if (realIssuer !== issuer) throw new Error('Use uma porta fixa para o mock OIDC');
  return { issuer, jwksUri: `${issuer}/jwks`, server, mintAccessToken, close: () => new Promise((r) => server.close(() => r())) };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('dev/mock-oidc.ts');
if (isMain) {
  const port = Number(process.env.MOCK_OIDC_PORT ?? 4100);
  const oidc = await startMockOidc({
    port,
    clientId: process.env.OIDC_CLIENT_ID ?? 'minions-web-dev',
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? 'dev-only-secret',
    apiAudience: process.env.OIDC_AUDIENCE ?? 'api://minions-api',
  });
  console.log(`Mock OIDC (somente desenvolvimento) em ${oidc.issuer}`);
}
