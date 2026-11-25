import { createMinions, loadEnv } from '@minions/core';
import { startWorker } from './worker-loop';

/** Worker de ingestão independente (produção: escale separadamente da API). */
const minions = await createMinions(loadEnv());
const stop = startWorker(minions);
minions.logger.info('minions_worker_started');

const shutdown = async () => {
  stop();
  await minions.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
