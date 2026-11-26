import 'server-only';
import type { Minions } from '@minions/core';

/**
 * API embutida: na Vercel não existe um servidor da API rodando à parte, então o mesmo app Hono
 * (apps/api) é executado dentro desta função do Next. A segurança não muda — cada chamada ainda
 * passa pela autenticação Bearer, ACL, rate limit e auditoria da API; o BFF continua filtrando
 * caminhos, headers e origem antes de chegar aqui.
 *
 * Ativa quando EMBEDDED_API=true, ou na Vercel sem API_URL. Localmente, o padrão continua sendo a
 * API separada (npm run dev) — o PGlite não admite dois processos no mesmo banco.
 */
export const isEmbedded = (): boolean => process.env.EMBEDDED_API === 'true' || (Boolean(process.env.VERCEL) && !process.env.API_URL);

interface Embedded {
  minions: Minions;
  app: { fetch(request: Request): Response | Promise<Response> };
}

// Guardado no globalThis: sobrevive ao recarregamento de módulos do `next dev` (uma instância por processo).
const g = globalThis as typeof globalThis & { __minionsEmbedded?: Promise<Embedded> };

export function getEmbedded(): Promise<Embedded> {
  g.__minionsEmbedded ??= (async () => {
    const [{ createMinions, loadEnv }, { createApp }] = await Promise.all([import('@minions/core'), import('@minions/api/app')]);
    const env = loadEnv(process.env);
    const minions = await createMinions(env);
    // O IP chega do BFF em x-forwarded-for (calculado por lib/client-ip, que não confia em headers falsificáveis).
    const app = createApp(minions, { trustProxy: true });
    minions.logger.info(
      { mode: 'embedded', auth: env.AUTH_MODE, ai: minions.llm ? `${minions.llm.id}:${minions.llm.model}` : 'extractive', db: minions.db.kind, storage: env.STORAGE_PROVIDER },
      'minions_api_started',
    );
    return { minions, app };
  })().catch((err) => {
    g.__minionsEmbedded = undefined; // permite nova tentativa na próxima requisição
    throw err;
  });
  return g.__minionsEmbedded;
}

/** Processa a fila de ingestão em segundo plano (após a resposta), dentro do prazo da função. */
export async function drainInBackground(budgetMs = 45_000): Promise<void> {
  try {
    const { minions } = await getEmbedded();
    const { drainJobs } = await import('@minions/api/maintenance');
    const n = await drainJobs(minions, { budgetMs });
    if (n) minions.logger.info({ processed: n }, 'ingestion_drained');
  } catch (err) {
    console.error('[minions] Falha ao processar a fila de ingestão:', (err as Error).message);
  }
}
