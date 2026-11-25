import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Portão de acesso da demonstração pública. Ativo quando DEMO_ACCESS_CODE está definido:
 * nenhuma página, rota da API ou ação do servidor responde sem o cookie derivado do código.
 * O cookie guarda um HMAC do código (nunca o código em si).
 */
export const DEMO_COOKIE = 'minions_demo';

export const demoCode = (): string | null => process.env.DEMO_ACCESS_CODE?.trim() || null;

export function demoToken(code: string): string {
  return createHmac('sha256', code).update('minions-demo-gate-v1').digest('base64url');
}

export function isDemoTokenValid(token: string | undefined | null): boolean {
  const code = demoCode();
  if (!code) return true;
  if (!token) return false;
  const expected = Buffer.from(demoToken(code));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function codeMatches(input: string): boolean {
  const code = demoCode();
  if (!code) return true;
  const a = Buffer.from(demoToken(code));
  const b = Buffer.from(demoToken(input.trim()));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Aceita apenas caminhos internos como destino após o código (evita open redirect). */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.startsWith('/acesso')) return '/';
  return value.slice(0, 512);
}
