import { randomUUID } from 'node:crypto';
import { ChatAnswerSchema, type ChatAnswer, type Conversation, type Message, type TraceEvent } from '../contracts';
import { iso, type Db } from '../db/client';
import { NotFoundError } from '../errors';
import type { Principal } from '../auth/policy';
import { truncate } from '../knowledge/text';

/** Conversas pertencem ao usuário: toda leitura/escrita filtra por owner_id (sem compartilhamento entre usuários). */
export class ConversationService {
  constructor(private readonly db: Db) {}

  async list(p: Principal, limit = 50): Promise<Conversation[]> {
    const rows = await this.db.query<{ id: string; title: string; created_at: Date; updated_at: Date; n: number }>(
      `select c.*, (select count(*)::int from messages m where m.conversation_id = c.id) as n
       from conversations c where c.owner_id = $1 order by c.updated_at desc limit $2`,
      [p.id, limit],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), messageCount: r.n }));
  }

  async create(p: Principal, firstMessage: string): Promise<Conversation> {
    const id = randomUUID();
    const title = truncate(firstMessage, 80);
    await this.db.query('insert into conversations (id, owner_id, title) values ($1, $2, $3)', [id, p.id, title]);
    return { id, title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0 };
  }

  async assertOwner(p: Principal, id: string): Promise<void> {
    const row = await this.db.one('select 1 from conversations where id = $1 and owner_id = $2', [id, p.id]).catch(() => undefined);
    if (!row) throw new NotFoundError('Conversa não encontrada');
  }

  async messages(p: Principal, id: string): Promise<Message[]> {
    await this.assertOwner(p, id);
    const rows = await this.db.query<{ id: string; role: 'user' | 'assistant'; content: string; answer: unknown; created_at: Date }>(
      'select id, role, content, answer, created_at from messages where conversation_id = $1 order by created_at, id',
      [id],
    );
    return rows.map((r) => {
      const parsed = r.answer ? ChatAnswerSchema.safeParse(r.answer) : null;
      return { id: r.id, role: r.role, content: r.content, answer: parsed?.success ? parsed.data : null, createdAt: iso(r.created_at) };
    });
  }

  /** Últimas perguntas do usuário na conversa (contexto para perguntas de acompanhamento). */
  async recentUserTurns(p: Principal, id: string, n = 3): Promise<string[]> {
    await this.assertOwner(p, id);
    const rows = await this.db.query<{ content: string }>(
      `select content from messages where conversation_id = $1 and role = 'user' order by created_at desc limit $2`,
      [id, n],
    );
    return rows.map((r) => r.content).reverse();
  }

  async appendUser(p: Principal, id: string, content: string): Promise<string> {
    await this.assertOwner(p, id);
    const mid = randomUUID();
    await this.db.query(`insert into messages (id, conversation_id, role, content) values ($1, $2, 'user', $3)`, [mid, id, content]);
    await this.db.query('update conversations set updated_at = now() where id = $1', [id]);
    return mid;
  }

  async appendAssistant(p: Principal, id: string, answer: ChatAnswer, trace: TraceEvent[]): Promise<string> {
    await this.assertOwner(p, id);
    const mid = randomUUID();
    await this.db.query(`insert into messages (id, conversation_id, role, content, answer, trace) values ($1, $2, 'assistant', $3, $4, $5)`, [
      mid,
      id,
      answer.summary,
      JSON.stringify(answer),
      JSON.stringify(trace),
    ]);
    await this.db.query('update conversations set updated_at = now() where id = $1', [id]);
    return mid;
  }

  async rename(p: Principal, id: string, title: string): Promise<void> {
    await this.assertOwner(p, id);
    await this.db.query('update conversations set title = $2 where id = $1', [id, truncate(title, 120)]);
  }

  async remove(p: Principal, id: string): Promise<void> {
    await this.assertOwner(p, id);
    await this.db.query('delete from conversations where id = $1', [id]);
  }

  async purgeOlderThan(days: number): Promise<number> {
    const rows = await this.db.query<{ id: string }>(`delete from conversations where updated_at < now() - ($1 || ' days')::interval returning id`, [String(days)]);
    return rows.length;
  }
}
