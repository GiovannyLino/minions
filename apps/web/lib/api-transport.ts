import 'server-only';
import { getEmbedded, isEmbedded } from './embedded';

export const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4000';

/**
 * Única porta de saída do web para a API: HTTP para a API separada (local / Azure) ou chamada em
 * processo para a API embutida (Vercel). `path` é sempre um caminho absoluto da API, ex.: /v1/me.
 */
export async function callApi(path: string, init: RequestInit & { duplex?: 'half' } = {}): Promise<Response> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Caminho de API inválido');
  if (isEmbedded()) {
    const { app } = await getEmbedded();
    const { redirect: _redirect, cache: _cache, ...rest } = init;
    return app.fetch(new Request(new URL(path, 'http://minions.internal'), rest));
  }
  return fetch(new URL(path, API_URL), init);
}
