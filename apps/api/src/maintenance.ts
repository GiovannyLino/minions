import { DbRateLimiter, type Minions } from '@minions/core';

/**
 * Processa a fila de ingestão até esvaziar ou até o prazo acabar. Em serverless (Vercel) é chamado
 * logo após uploads e pela rotina diária, já que não existe um worker rodando o tempo todo.
 */
export async function drainJobs(minions: Minions, opts: { budgetMs?: number; max?: number } = {}): Promise<number> {
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  const max = opts.max ?? 50;
  let n = 0;
  while (n < max && Date.now() < deadline) {
    if (!(await minions.documents.processNextJob())) break;
    n++;
  }
  return n;
}

/** Retenção (LGPD) e limpeza de tabelas auxiliares. */
export async function runRetention(minions: Minions): Promise<{ conversations: number; audit: number; rateLimits: number }> {
  const conversations = await minions.conversations.purgeOlderThan(minions.env.RETENTION_CONVERSATION_DAYS);
  const audit = await minions.audit.purgeOlderThan(minions.env.RETENTION_AUDIT_DAYS);
  const rateLimits = await DbRateLimiter.purge(minions.db);
  return { conversations, audit, rateLimits };
}
