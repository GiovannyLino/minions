import { serve } from '@hono/node-server';
import { createMinions, loadEnv, type Minions } from '@minions/core';
import { createApp } from './app';
import { startWorker } from './worker-loop';

let env: ReturnType<typeof loadEnv>;
let minions: Minions;
try {
  env = loadEnv();
  minions = await createMinions(env);
} catch (err) {
  // Mensagem curta e acionável em vez de um stack trace minificado.
  console.error(`
[minions] Não foi possível iniciar a API: ${(err as Error).message}
`);
  process.exit(1);
}
const app = createApp(minions);

// Cópia de segurança periódica do banco local (PGlite) — base para a autorrecuperação.
const backupTimer = minions.db.backup
  ? setInterval(() => void minions.db.backup!().catch((err: Error) => minions.logger.warn({ err: err.message }, 'backup_failed')), 10 * 60_000)
  : null;
backupTimer?.unref();

// Pré-aquecimento dos modelos locais: a primeira pergunta não espera o carregamento na GPU.
void (async () => {
  const started = Date.now();
  try {
    await minions.embeddings.embed(['aquecimento'], 'query');
    const llm = minions.llm as { warmUp?: () => Promise<void> } | null;
    await llm?.warmUp?.();
    minions.logger.info({ ms: Date.now() - started }, 'models_warmed_up');
  } catch (err) {
    minions.logger.warn({ err: (err as Error).message }, 'warmup_failed');
  }
})();

const stopWorker = env.EMBEDDED_WORKER ? startWorker(minions) : () => undefined;

const server = serve({ fetch: app.fetch, port: env.API_PORT, hostname: env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1' }, (info) => {
  minions.logger.info(
    { port: info.port, auth: env.AUTH_MODE, ai: minions.llm ? `${minions.llm.id}:${minions.llm.model}` : 'extractive', db: minions.db.kind, worker: env.EMBEDDED_WORKER },
    'minions_api_started',
  );
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  stopWorker();
  if (backupTimer) clearInterval(backupTimer);
  server.close();
  await minions.close(); // faz backup e libera a trava do banco
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
