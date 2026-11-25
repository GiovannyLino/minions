import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AgentSettingsSchema, type AgentSettings, type CategoryDTO, type DashboardDTO } from '../contracts';
import type { AuditService } from '../audit/audit';
import { assertCan, documentAccessSql, type Principal } from '../auth/policy';
import { iso, type Db } from '../db/client';
import { ConflictError, NotFoundError, ValidationError } from '../errors';

export const CategoryInputSchema = z.object({ name: z.string().trim().min(2).max(80), description: z.string().trim().max(400).default('') });

export class SettingsService {
  private cache: { value: AgentSettings; at: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly defaults: AgentSettings,
    private readonly audit: AuditService,
  ) {}

  async agentSettings(): Promise<AgentSettings> {
    if (this.cache && Date.now() - this.cache.at < 15_000) return this.cache.value;
    const row = await this.db.one<{ value: unknown }>(`select value from settings where key = 'agents'`);
    const parsed = row ? AgentSettingsSchema.safeParse({ ...this.defaults, ...(row.value as object) }) : null;
    const value = parsed?.success ? parsed.data : this.defaults;
    this.cache = { value, at: Date.now() };
    return value;
  }

  async updateAgentSettings(p: Principal, input: unknown): Promise<AgentSettings> {
    assertCan(p, 'admin:settings');
    const parsed = AgentSettingsSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('Configuração inválida', parsed.error.flatten());
    await this.db.query(
      `insert into settings (key, value, updated_by) values ('agents', $1, $2) on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [JSON.stringify(parsed.data), p.id],
    );
    this.cache = null;
    await this.audit.record({ actorId: p.id, action: 'settings.agents_updated', targetType: 'settings', targetId: 'agents', metadata: parsed.data });
    return parsed.data;
  }
}

export class CategoryService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<CategoryDTO[]> {
    const rows = await this.db.query<{ id: string; name: string; description: string; n: number }>(
      `select c.*, (select count(*)::int from documents d where d.category = c.name and d.status <> 'archived') as n from categories c order by c.name`,
    );
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, documentCount: r.n }));
  }

  async create(p: Principal, input: unknown): Promise<CategoryDTO> {
    assertCan(p, 'admin:categories');
    const parsed = CategoryInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('Categoria inválida', parsed.error.flatten());
    if (await this.db.one('select 1 from categories where lower(name) = lower($1)', [parsed.data.name])) throw new ConflictError('Categoria já existe');
    const id = randomUUID();
    await this.db.query('insert into categories (id, name, description) values ($1, $2, $3)', [id, parsed.data.name, parsed.data.description]);
    await this.audit.record({ actorId: p.id, action: 'category.created', targetType: 'category', targetId: id, metadata: { name: parsed.data.name } });
    return { id, ...parsed.data, documentCount: 0 };
  }

  async remove(p: Principal, id: string): Promise<void> {
    assertCan(p, 'admin:categories');
    const cat = await this.db.one<{ name: string }>('select name from categories where id = $1', [id]).catch(() => undefined);
    if (!cat) throw new NotFoundError('Categoria não encontrada');
    if (await this.db.one('select 1 from documents where category = $1', [cat.name])) throw new ConflictError('Categoria em uso por documentos');
    await this.db.query('delete from categories where id = $1', [id]);
    await this.audit.record({ actorId: p.id, action: 'category.deleted', targetType: 'category', targetId: id, metadata: { name: cat.name } });
  }
}

export class DashboardService {
  constructor(private readonly db: Db) {}

  async forUser(p: Principal, opts: { aiMode: 'llm' | 'extractive'; aiProvider: string | null; offline: boolean; realDataAllowed: boolean }): Promise<DashboardDTO> {
    const acl = documentAccessSql(p, 'd', 1);
    const docStats = await this.db.one<{ total: number; ready: number; chunks: number }>(
      `select count(*)::int as total, count(*) filter (where d.status = 'ready')::int as ready,
              coalesce(sum((select count(*) from chunks c where c.version_id = d.current_version_id)), 0)::int as chunks
       from documents d where d.status <> 'archived' and ${acl.sql}`,
      acl.params,
    );
    const counts = await this.db.one<{ proposals: number; people: number; convs: number; q7: number; answered7: number }>(
      `select (select count(*)::int from proposals) as proposals, (select count(*)::int from people) as people,
              (select count(*)::int from conversations where owner_id = $1) as convs,
              (select count(*)::int from messages m join conversations c on c.id = m.conversation_id where c.owner_id = $1 and m.role = 'assistant' and m.created_at > now() - interval '7 days') as q7,
              (select count(*)::int from messages m join conversations c on c.id = m.conversation_id where c.owner_id = $1 and m.role = 'assistant' and m.created_at > now() - interval '7 days' and m.answer->>'status' <> 'insufficient') as answered7`,
      [p.id],
    );
    const recentDocuments = await this.db.query<{ id: string; title: string; category: string; area: string; status: DashboardDTO['recentDocuments'][number]['status']; updated_at: Date; version: number | null }>(
      `select d.id, d.title, d.category, d.area, d.status, d.updated_at, v.version from documents d
       left join document_versions v on v.id = d.current_version_id
       where d.status <> 'archived' and ${acl.sql} order by d.created_at desc limit 6`,
      acl.params,
    );
    const recentConversations = await this.db.query<{ id: string; title: string; created_at: Date; updated_at: Date }>(
      'select * from conversations where owner_id = $1 order by updated_at desc limit 5',
      [p.id],
    );
    const activity = await this.db.query<{ day: string; questions: number; uploads: number }>(
      `select to_char(d.day, 'YYYY-MM-DD') as day,
              (select count(*)::int from messages m join conversations c on c.id = m.conversation_id where c.owner_id = $1 and m.role = 'user' and m.created_at::date = d.day) as questions,
              (select count(*)::int from document_versions v where v.created_at::date = d.day) as uploads
       from generate_series(current_date - 13, current_date, interval '1 day') as d(day) order by d.day`,
      [p.id],
    );
    return {
      stats: {
        documents: docStats?.total ?? 0,
        readyDocuments: docStats?.ready ?? 0,
        chunks: docStats?.chunks ?? 0,
        proposals: counts?.proposals ?? 0,
        people: counts?.people ?? 0,
        myConversations: counts?.convs ?? 0,
        questionsLast7d: counts?.q7 ?? 0,
        answeredRateLast7d: counts && counts.q7 > 0 ? counts.answered7 / counts.q7 : null,
      },
      recentDocuments: recentDocuments.map((d) => ({ id: d.id, title: d.title, category: d.category, area: d.area, status: d.status, updatedAt: iso(d.updated_at), currentVersion: d.version ?? 0 })),
      recentConversations: recentConversations.map((c) => ({ id: c.id, title: c.title, createdAt: iso(c.created_at), updatedAt: iso(c.updated_at) })),
      activity,
      aiMode: opts.aiMode,
      aiProvider: opts.aiProvider,
      offline: opts.offline,
      realDataAllowed: opts.realDataAllowed,
    };
  }
}
