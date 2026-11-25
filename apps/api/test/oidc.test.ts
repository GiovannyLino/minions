import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOCK_GROUP_MAP, MOCK_IDENTITIES, startMockOidc, type MockOidc } from '../src/dev/mock-oidc';
import { createTestSystem } from './helpers';

const AUDIENCE = 'api://minions-api';
let oidc: MockOidc;
let sys: Awaited<ReturnType<typeof createTestSystem>>;
const [ana, , carla, diego] = MOCK_IDENTITIES;

const call = (token: string, path: string, init: RequestInit = {}) =>
  sys.app.request(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });

beforeAll(async () => {
  oidc = await startMockOidc({ port: 4199, clientId: 'web-test', clientSecret: 's', apiAudience: AUDIENCE });
  sys = await createTestSystem({
    env: {
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: oidc.issuer,
      OIDC_AUDIENCE: `${AUDIENCE}, 00000000-0000-0000-0000-00000000a001`,
      OIDC_JWKS_URI: oidc.jwksUri,
      OIDC_GROUP_MAP: JSON.stringify(MOCK_GROUP_MAP),
    },
  });
});
afterAll(async () => {
  await sys.minions.close();
  await oidc.close();
});

describe('autenticação corporativa (OIDC / Entra ID)', () => {
  it('provisiona o usuário no primeiro acesso com papel das app roles e grupos mapeados', async () => {
    const me = (await (await call(await oidc.mintAccessToken(diego!), '/v1/me')).json()) as { role: string; groups: string[]; email: string; clearance: string };
    expect(me).toMatchObject({ role: 'collaborator', groups: ['financeiro'], email: diego!.email, clearance: 'internal' });
    const admin = (await (await call(await oidc.mintAccessToken(ana!), '/v1/me')).json()) as { role: string };
    expect(admin.role).toBe('admin');
  });

  it('aceita qualquer uma das audiências configuradas (v1 App ID URI ou v2 client ID)', async () => {
    const token = await oidc.mintAccessToken(diego!, {}, { audience: '00000000-0000-0000-0000-00000000a001' });
    expect((await call(token, '/v1/me')).status).toBe(200);
  });

  it('rejeita tokens inválidos', async () => {
    const wrongAudience = await oidc.mintAccessToken(diego!, {}, { audience: 'api://outra-api' });
    const expired = await oidc.mintAccessToken(diego!, { exp: Math.floor(Date.now() / 1000) - 3600 }, { expiresIn: '-1h' });
    const noScope = await oidc.mintAccessToken(diego!, { scp: 'User.Read' });
    const { privateKey } = await generateKeyPair('RS256');
    const forged = await new SignJWT({ oid: diego!.oid, preferred_username: diego!.email, scp: 'access_as_user', roles: ['Minions.Admin'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'atacante' })
      .setIssuer(oidc.issuer)
      .setAudience(AUDIENCE)
      .setExpirationTime('1h')
      .sign(privateKey);
    const hs256 = await new SignJWT({ oid: diego!.oid, preferred_username: diego!.email, scp: 'access_as_user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(oidc.issuer)
      .setAudience(AUDIENCE)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('x'.repeat(48)));
    for (const t of [wrongAudience, expired, noScope, forged, hs256]) expect((await call(t, '/v1/me')).status).toBe(401);
  });

  it('desabilita o login de desenvolvimento', async () => {
    expect((await sys.app.request('/v1/auth/dev-users')).status).toBe(404);
    const cfg = (await (await sys.app.request('/v1/auth/config')).json()) as { mode: string; devLogin: boolean };
    expect(cfg).toMatchObject({ mode: 'oidc', devLogin: false });
  });

  it('não vincula conta existente apenas pelo e-mail', async () => {
    const takeover = await oidc.mintAccessToken({ ...carla!, oid: 'b0000000-0000-4000-8000-0000000000ff', email: 'ana.ribeiro@exemplo.test' } as never, { preferred_username: 'ana.ribeiro@exemplo.test' });
    expect((await call(takeover, '/v1/me')).status).toBe(403);
  });

  it('aplica a mesma ACL aos usuários corporativos', async () => {
    const token = await oidc.mintAccessToken(diego!);
    const list = (await (await call(token, '/v1/documents?limit=200')).json()) as { items: { title: string }[] };
    expect(list.items.some((d) => d.title.includes('Contrato-quadro') || d.title.includes('Manual de Elaboração'))).toBe(false);
    const res = await call(token, '/v1/chat', { method: 'POST', body: JSON.stringify({ message: 'Como abrir uma solicitação de compras?' }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Portal de Suprimentos');
  });

  it('papel removido no IdP é refletido no próximo acesso', async () => {
    const asAdmin = await oidc.mintAccessToken(ana!);
    expect((await call(asAdmin, '/v1/admin/users')).status).toBe(200);
    const demoted = await oidc.mintAccessToken(ana!, { roles: [] });
    expect((await call(demoted, '/v1/admin/users')).status).toBe(403);
  });
});

