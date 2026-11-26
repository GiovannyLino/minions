import type { Queryable } from '../db/client';

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number };

/** Limitador de requisições. Implementações síncronas (memória) ou assíncronas (banco). */
export interface RateLimiter {
  take(key: string, cost?: number): RateLimitResult | Promise<RateLimitResult>;
}

/**
 * Janela fixa guardada no Postgres: o limite vale para TODAS as instâncias (essencial em serverless,
 * onde cada função tem a própria memória e um limitador em memória seria contornável).
 * Uma única instrução atômica por chamada (insert … on conflict).
 */
export class DbRateLimiter implements RateLimiter {
  constructor(
    private readonly db: Queryable,
    private readonly limit: number,
    private readonly windowSeconds = 60,
  ) {}

  async take(key: string, cost = 1): Promise<RateLimitResult> {
    const rows = await this.db.query<{ hits: number; retry: number }>(
      `insert into rate_limits as r (key, window_start, hits) values ($1, now(), $2::int)
       on conflict (key) do update set
         hits = case when r.window_start <= now() - make_interval(secs => $3::double precision) then $2::int else r.hits + $2::int end,
         window_start = case when r.window_start <= now() - make_interval(secs => $3::double precision) then now() else r.window_start end
       returning hits, extract(epoch from (window_start + make_interval(secs => $3::double precision) - now()))::float8 as retry`,
      [key.slice(0, 200), cost, this.windowSeconds],
    );
    const row = rows[0]!;
    if (row.hits <= this.limit) return { ok: true };
    return { ok: false, retryAfter: Math.max(1, Math.ceil(Number(row.retry))) };
  }

  /** Remove janelas antigas (chamado pela rotina diária). */
  static async purge(db: Queryable): Promise<number> {
    const rows = await db.query(`delete from rate_limits where window_start < now() - interval '1 day' returning key`);
    return rows.length;
  }
}
