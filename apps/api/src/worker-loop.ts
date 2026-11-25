import type { Minions } from '@minions/core';

/** Laço do worker de ingestão + limpeza de retenção. Retorna uma função para parar. */
export function startWorker(minions: Minions, opts: { idleMs?: number } = {}): () => void {
  let stopped = false;
  const idleMs = opts.idleMs ?? 2000;
  const loop = async () => {
    while (!stopped) {
      try {
        const worked = await minions.documents.processNextJob();
        if (!worked) await new Promise((r) => setTimeout(r, idleMs));
      } catch (err) {
        minions.logger.error({ err }, 'worker_error');
        await new Promise((r) => setTimeout(r, idleMs * 5));
      }
    }
  };
  void loop();

  const retention = setInterval(async () => {
    try {
      const convs = await minions.conversations.purgeOlderThan(minions.env.RETENTION_CONVERSATION_DAYS);
      const audit = await minions.audit.purgeOlderThan(minions.env.RETENTION_AUDIT_DAYS);
      if (convs || audit) minions.logger.info({ convs, audit }, 'retention_purge');
    } catch (err) {
      minions.logger.error({ err }, 'retention_error');
    }
  }, 6 * 3600_000);
  retention.unref();

  return () => {
    stopped = true;
    clearInterval(retention);
  };
}
