import 'server-only';
import { getEmbedded, isEmbedded } from './embedded';

/**
 * Limite de tentativas erradas do código de acesso: 5 por IP a cada 10 minutos.
 * Na Vercel (API embutida + Postgres) o contador fica no banco — vale para todas as instâncias.
 * Com a API separada (npm run share), fica na memória do processo web.
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60_000;
const memory = new Map<string, { count: number; until: number }>();

async function dbLimiter() {
  if (!isEmbedded()) return null;
  const { minions } = await getEmbedded();
  if (minions.db.kind !== 'pg') return null;
  const { DbRateLimiter } = await import('@minions/core');
  return new DbRateLimiter(minions.db, MAX_FAILURES - 1, WINDOW_MS / 1000);
}

export async function isGateBlocked(ip: string): Promise<boolean> {
  const db = await dbLimiter();
  if (db) return !(await db.take(`gate:${ip}`, 0)).ok;
  const entry = memory.get(ip);
  return Boolean(entry && entry.until > Date.now() && entry.count >= MAX_FAILURES);
}

export async function recordGateFailure(ip: string): Promise<void> {
  const db = await dbLimiter();
  if (db) {
    await db.take(`gate:${ip}`, 1);
    return;
  }
  const now = Date.now();
  const entry = memory.get(ip);
  const fresh = !entry || entry.until < now;
  memory.set(ip, { count: fresh ? 1 : entry.count + 1, until: fresh ? now + WINDOW_MS : entry.until });
  if (memory.size > 10_000) memory.clear();
}

export function clearGateFailures(ip: string): void {
  memory.delete(ip);
}
