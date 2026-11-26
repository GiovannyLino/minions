import { timingSafeEqual } from 'node:crypto';
import { drainInBackground, getEmbedded, isEmbedded } from '@/lib/embedded';

/**
 * Rotina diária da Vercel (vercel.json → crons): indexa o que ficou na fila e aplica a retenção (LGPD).
 * Fora do portão da demo, mas exige `Authorization: Bearer <CRON_SECRET>` — a Vercel envia o header
 * automaticamente quando CRON_SECRET está definido no projeto. Sem CRON_SECRET, a rota não existe.
 */
function authorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  if (!isEmbedded() || !authorized(request.headers.get('authorization'))) {
    return Response.json({ error: { code: 'not_found', message: 'Rota não encontrada' } }, { status: 404 });
  }
  const { minions } = await getEmbedded();
  const { runRetention } = await import('@minions/api/maintenance');
  const retention = await runRetention(minions);
  await drainInBackground(40_000);
  minions.logger.info(retention, 'cron_daily');
  return Response.json({ ok: true, retention });
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
