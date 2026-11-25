/**
 * `npm run dev:sso` — sobe o IdP OIDC de desenvolvimento, a API e o web em modo de autenticação
 * corporativa (AUTH_MODE=oidc), reproduzindo localmente o fluxo do Microsoft Entra ID.
 * Somente desenvolvimento: identidades fictícias e segredo fixo.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOCK_GROUP_MAP, startMockOidc } from './mock-oidc';

if (process.env.NODE_ENV === 'production') throw new Error('dev:sso é somente para desenvolvimento');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PORT = 4100;
const CLIENT_ID = 'minions-web-dev';
const CLIENT_SECRET = 'dev-only-secret';
const AUDIENCE = 'api://minions-api';

const oidc = await startMockOidc({ port: PORT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, apiAudience: AUDIENCE });
console.log(`[sso] IdP de desenvolvimento em ${oidc.issuer}`);

const shared = { ...process.env, FORCE_COLOR: '1' };
const children: ChildProcess[] = [
  spawn('npm run dev -w @minions/api', {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...shared, AUTH_MODE: 'oidc', OIDC_ISSUER: oidc.issuer, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: oidc.jwksUri, OIDC_GROUP_MAP: JSON.stringify(MOCK_GROUP_MAP) },
  }),
  spawn('npm run dev -w @minions/web', {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...shared, OIDC_ISSUER: oidc.issuer, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET, OIDC_API_SCOPE: `${AUDIENCE}/access_as_user`, APP_URL: 'http://localhost:3000' },
  }),
];

const stop = async () => {
  for (const c of children) c.kill();
  await oidc.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => code && code !== 0 && void stop());
