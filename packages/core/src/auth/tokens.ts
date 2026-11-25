import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { UnauthorizedError } from '../errors';

const DEV_ISSUER = 'minions-dev';
const AUDIENCE = 'minions-api';

/** Token de sessão do modo de desenvolvimento (HS256). Bloqueado em produção pela validação de ambiente. */
export async function signDevToken(secret: string, userId: string, ttlSeconds = 8 * 3600): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(DEV_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyDevToken(secret: string, token: string): Promise<{ userId: string }> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: DEV_ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (!payload.sub) throw new Error('sub ausente');
    return { userId: payload.sub };
  } catch {
    throw new UnauthorizedError('Sessão inválida ou expirada');
  }
}

export interface OidcIdentity {
  externalId: string;
  email: string;
  name: string;
  groups: string[];
  roles: string[];
  /** O IdP omitiu os grupos por excesso (>200 no Entra). Configure "grupos atribuídos ao aplicativo". */
  groupsOverage?: boolean;
}

export interface OidcVerifierConfig {
  issuer: string;
  /** Uma ou mais audiências aceitas (Entra v2: client ID da API; v1: App ID URI). Separadas por vírgula. */
  audience: string;
  jwksUri: string;
  groupsClaim: string;
  rolesClaim: string;
  /** Escopo delegado exigido em `scp` (vazio = não exigir). */
  requiredScope?: string;
  /** objectId do grupo no IdP → nome do grupo no Minions. Grupos não mapeados são descartados. */
  groupMap?: Record<string, string>;
}

/**
 * Verificador de access tokens OIDC (Microsoft Entra ID ou outro IdP): assinatura via JWKS (RS256),
 * emissor, audiência, expiração e escopo delegado. Algoritmos simétricos e `none` nunca são aceitos.
 */
export function createOidcVerifier(cfg: OidcVerifierConfig) {
  const jwks = createRemoteJWKSet(new URL(cfg.jwksUri), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
  const audiences = cfg.audience.split(',').map((a) => a.trim()).filter(Boolean);
  const groupMap = cfg.groupMap ?? {};
  const mapGroups = Object.keys(groupMap).length > 0;
  return async (token: string): Promise<OidcIdentity> => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, { issuer: cfg.issuer, audience: audiences, algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'ES256'], clockTolerance: 60 }));
    } catch {
      throw new UnauthorizedError('Token corporativo inválido ou expirado');
    }
    const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : undefined);
    const arr = (k: string) => (Array.isArray(payload[k]) ? (payload[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
    if (cfg.requiredScope) {
      const scopes = (str('scp') ?? '').split(' ');
      if (!scopes.includes(cfg.requiredScope)) throw new UnauthorizedError('Token sem o escopo de acesso ao Minions');
    }
    const externalId = str('oid') ?? payload.sub;
    const email = str('preferred_username') ?? str('email') ?? str('upn');
    if (!externalId || !email) throw new UnauthorizedError('Token sem identificação do usuário');
    // Entra envia grupos como objectIds (GUID). Sem mapa configurado, mantém o valor recebido.
    const rawGroups = arr(cfg.groupsClaim).map((g) => g.toLowerCase());
    const groups = mapGroups ? rawGroups.map((g) => groupMap[g]).filter((g): g is string => Boolean(g)) : rawGroups;
    return {
      externalId,
      email: email.toLowerCase(),
      name: str('name') ?? email,
      groups: [...new Set(groups)],
      roles: arr(cfg.rolesClaim),
      groupsOverage: Boolean((payload as { _claim_names?: Record<string, unknown> })._claim_names?.groups),
    };
  };
}

/** Mapeia app roles do Entra ID para papéis do Minions. */
export function roleFromClaims(roles: string[]): 'admin' | 'manager' | 'collaborator' {
  const set = new Set(roles.map((r) => r.toLowerCase()));
  if (set.has('minions.admin')) return 'admin';
  if (set.has('minions.manager')) return 'manager';
  return 'collaborator';
}

// ───────────────────────── Links assinados de download ─────────────────────────

export interface DownloadClaims {
  documentId: string;
  versionId: string;
  userId: string;
  expiresAt: number; // epoch ms
}

export function signDownloadToken(secret: string, claims: Omit<DownloadClaims, 'expiresAt'>, ttlMs = 5 * 60_000): string {
  const body = Buffer.from(JSON.stringify({ ...claims, expiresAt: Date.now() + ttlMs })).toString('base64url');
  const sig = createHmac('sha256', `download:${secret}`).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyDownloadToken(secret: string, token: string): DownloadClaims {
  const [body, sig] = token.split('.');
  if (!body || !sig) throw new UnauthorizedError('Link inválido');
  const expected = createHmac('sha256', `download:${secret}`).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedError('Link inválido');
  let claims: DownloadClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DownloadClaims;
  } catch {
    throw new UnauthorizedError('Link inválido');
  }
  if (typeof claims.expiresAt !== 'number' || claims.expiresAt < Date.now()) throw new UnauthorizedError('Link expirado');
  return claims;
}
