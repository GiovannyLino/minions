import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { AppError, RateLimitError, UnauthorizedError, verifyDevToken, type Minions, type Principal, type RateLimiter } from '@minions/core';

export type AppEnv = { Variables: { principal: Principal; minions: Minions; requestId: string } };

export function clientIp(c: Context, trustProxy: boolean): string | null {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (fwd) return fwd.slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** Autenticação: Bearer obrigatório. Modo dev (HS256) ou OIDC (Entra ID). O usuário é recarregado do banco a cada requisição. */
export function authenticate(minions: Minions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) throw new UnauthorizedError();
    let principal: Principal;
    if (minions.env.AUTH_MODE === 'oidc') {
      const identity = await minions.oidcVerifier!(token);
      // Excesso de grupos: o token não traz a lista → menor privilégio (sem grupos) e alerta para o admin.
      if (identity.groupsOverage) minions.logger.warn({ user: identity.externalId }, 'oidc_groups_overage');
      principal = await minions.users.provisionFromOidc(identity);
    } else {
      const { userId } = await verifyDevToken(minions.env.AUTH_SECRET, token);
      principal = await minions.users.principalFor(userId);
    }
    c.set('principal', principal);
    await next();
  };
}

/**
 * Rate limit por token bucket em memória (uma instância). Com várias instâncias usa-se o
 * DbRateLimiter do núcleo, com a mesma interface.
 */
export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly burst = perMinute,
  ) {}

  take(key: string, cost = 1): { ok: true } | { ok: false; retryAfter: number } {
    const now = Date.now();
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) * rate);
    b.at = now;
    if (b.tokens < cost) {
      this.buckets.set(key, b);
      return { ok: false, retryAfter: Math.ceil((cost - b.tokens) / rate / 1000) };
    }
    b.tokens -= cost;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.buckets.clear();
    return { ok: true };
  }
}

export function rateLimit(limiter: RateLimiter, keyOf: (c: Context<AppEnv>) => string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = await limiter.take(keyOf(c));
    if (!result.ok) {
      c.header('Retry-After', String(result.retryAfter));
      throw new RateLimitError(result.retryAfter);
    }
    await next();
  };
}

export function errorBody(err: unknown): { status: number; body: { error: { code: string; message: string; details?: unknown } } } {
  if (err instanceof AppError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } } };
  }
  return { status: 500, body: { error: { code: 'internal_error', message: 'Erro interno. A equipe técnica foi notificada.' } } };
}
