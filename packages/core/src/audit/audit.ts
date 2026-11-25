import { randomUUID } from 'node:crypto';
import type { AuditEntry } from '../contracts';
import { iso, type Db } from '../db/client';
import type { Logger } from '../logging/logger';

export interface AuditEvent {
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  outcome?: 'success' | 'denied' | 'error';
  /** Somente metadados — nunca conteúdo de documentos ou perguntas completas. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly logger?: Logger,
  ) {}

  async record(e: AuditEvent): Promise<void> {
    try {
      await this.db.query(
        `insert into audit_log (id, actor_id, action, target_type, target_id, outcome, metadata, ip) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), e.actorId, e.action, e.targetType ?? null, e.targetId ?? null, e.outcome ?? 'success', JSON.stringify(e.metadata ?? {}), e.ip ?? null],
      );
    } catch (err) {
      // Falha de auditoria não deve derrubar a operação, mas precisa ficar visível.
      this.logger?.error({ err, action: e.action }, 'audit_write_failed');
    }
  }

  async list(filter: { action?: string; actorId?: string; limit?: number; before?: string } = {}): Promise<AuditEntry[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.action) {
      params.push(`${filter.action}%`);
      where.push(`a.action like $${params.length}`);
    }
    if (filter.actorId) {
      params.push(filter.actorId);
      where.push(`a.actor_id = $${params.length}`);
    }
    if (filter.before) {
      params.push(filter.before);
      where.push(`a.at < $${params.length}`);
    }
    params.push(Math.min(filter.limit ?? 100, 500));
    const rows = await this.db.query<{
      id: string; at: Date; actor_id: string | null; actor_name: string | null; action: string; target_type: string | null; target_id: string | null; outcome: AuditEntry['outcome']; metadata: Record<string, unknown>;
    }>(
      `select a.*, u.name as actor_name from audit_log a left join users u on u.id = a.actor_id
       ${where.length ? `where ${where.join(' and ')}` : ''} order by a.at desc limit $${params.length}`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      at: iso(r.at),
      actorId: r.actor_id,
      actorName: r.actor_name,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      outcome: r.outcome,
      metadata: r.metadata ?? {},
    }));
  }

  async purgeOlderThan(days: number): Promise<number> {
    const rows = await this.db.query<{ id: string }>(`delete from audit_log where at < now() - ($1 || ' days')::interval returning id`, [String(days)]);
    return rows.length;
  }
}
