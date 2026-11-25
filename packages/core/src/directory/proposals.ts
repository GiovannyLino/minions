import { randomUUID } from 'node:crypto';
import { CLASSIFICATION_RANK, PROPOSAL_STATUS_LABEL, ProposalInputSchema, type ProposalDTO, type ProposalInput } from '../contracts';
import type { AuditService } from '../audit/audit';
import { assertCan, documentAccessSql, effectiveGroups, proposalAccessSql, type Principal } from '../auth/policy';
import { iso, type Db, type Queryable } from '../db/client';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { anchorTerms, buildTsQuery, termCoverage } from '../knowledge/search';

interface ProposalRow {
  id: string;
  code: string;
  name: string;
  client: string;
  description: string;
  scope: string;
  status: ProposalDTO['status'];
  area: string;
  classification: ProposalDTO['classification'];
  owner_person_id: string | null;
  owner_name: string | null;
  due_date: Date | string | null;
  deliverables: string[];
  created_at: Date;
  updated_at: Date;
  members: { id: string; name: string; jobTitle: string | null }[] | null;
}

const selectSql = (extraCols = '', extraFrom = '') => `
  select pr.*, op.name as owner_name,
    (select coalesce(json_agg(json_build_object('id', pe.id, 'name', pe.name, 'jobTitle', pe.job_title) order by pe.name), '[]'::json)
       from proposal_members m join people pe on pe.id = m.person_id where m.proposal_id = pr.id) as members ${extraCols}
  from proposals pr left join people op on op.id = pr.owner_person_id ${extraFrom}`;
const SELECT = selectSql();

const dateOnly = (d: Date | string | null) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** $2 code, $3 name, $4 client, $5 description, $6 scope */
const TSV = `setweight(to_tsvector('portuguese', unaccent($2 || ' ' || $3)), 'A') || setweight(to_tsvector('portuguese', unaccent($4 || ' ' || $5)), 'B') || setweight(to_tsvector('portuguese', unaccent($6)), 'C')`;

export interface ProposalMatch {
  proposal: ProposalDTO;
  score: number;
}

export class ProposalService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async hydrate(p: Principal, rows: ProposalRow[], withDetails: boolean): Promise<ProposalDTO[]> {
    const out: ProposalDTO[] = [];
    for (const r of rows) {
      let documents: ProposalDTO['documents'] = [];
      let history: ProposalDTO['history'] = [];
      if (withDetails) {
        // Documentos associados também respeitam a ACL de documentos.
        const acl = documentAccessSql(p, 'd', 2);
        documents = await this.db.query<{ id: string; title: string; category: string }>(
          `select d.id, d.title, d.category from documents d where d.proposal_id = $1 and d.status <> 'archived' and ${acl.sql} order by d.title`,
          [r.id, ...acl.params],
        );
        history = (
          await this.db.query<{ at: Date; by: string | null; change: string }>(
            `select h.at, u.name as by, h.change from proposal_history h left join users u on u.id = h.by_user where h.proposal_id = $1 order by h.at desc limit 50`,
            [r.id],
          )
        ).map((h) => ({ at: iso(h.at), by: h.by, change: h.change }));
      }
      out.push({
        id: r.id,
        code: r.code,
        name: r.name,
        client: r.client,
        description: r.description,
        scope: r.scope,
        status: r.status,
        area: r.area,
        classification: r.classification,
        ownerPersonId: r.owner_person_id,
        ownerName: r.owner_name,
        memberPersonIds: (r.members ?? []).map((m) => m.id),
        members: r.members ?? [],
        dueDate: dateOnly(r.due_date),
        deliverables: r.deliverables ?? [],
        documents,
        history,
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
      });
    }
    return out;
  }

  async list(p: Principal, filter: { q?: string; status?: string } = {}): Promise<ProposalDTO[]> {
    assertCan(p, 'proposals:read');
    const acl = proposalAccessSql(p, 'pr', 1);
    const params = [...acl.params];
    const where = [acl.sql];
    if (filter.status) {
      params.push(filter.status);
      where.push(`pr.status = $${params.length}`);
    }
    if (filter.q) {
      params.push(`%${filter.q.replace(/[%_]/g, '')}%`);
      where.push(`(pr.code ilike $${params.length} or pr.name ilike $${params.length} or pr.client ilike $${params.length})`);
    }
    const rows = await this.db.query<ProposalRow>(`${SELECT} where ${where.join(' and ')} order by pr.updated_at desc limit 200`, params);
    return this.hydrate(p, rows, false);
  }

  async get(p: Principal, id: string): Promise<ProposalDTO> {
    assertCan(p, 'proposals:read');
    const acl = proposalAccessSql(p, 'pr', 2);
    const row = await this.db.one<ProposalRow>(`${SELECT} where pr.id = $1 and ${acl.sql}`, [id, ...acl.params]).catch(() => undefined);
    if (!row) throw new NotFoundError('Proposta não encontrada');
    return (await this.hydrate(p, [row], true))[0]!;
  }

  private assertWritable(p: Principal, input: Pick<ProposalInput, 'area' | 'classification'>) {
    if (p.role !== 'admin' && !effectiveGroups(p).includes(input.area.toLowerCase())) throw new ForbiddenError('Gestores só podem gerir propostas da própria área');
    if (CLASSIFICATION_RANK[input.classification] > CLASSIFICATION_RANK[p.clearance]) throw new ForbiddenError('Classificação acima da sua habilitação');
  }

  private async writeMembers(tx: Queryable, id: string, memberIds: string[]) {
    await tx.query('delete from proposal_members where proposal_id = $1', [id]);
    for (const m of new Set(memberIds)) await tx.query('insert into proposal_members (proposal_id, person_id) values ($1, $2)', [id, m]);
  }

  async create(p: Principal, input: unknown): Promise<ProposalDTO> {
    assertCan(p, 'proposals:write');
    const parsed = ProposalInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('Dados inválidos', parsed.error.flatten());
    const d = parsed.data;
    this.assertWritable(p, d);
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into proposals (id, code, name, client, description, scope, status, area, classification, owner_person_id, due_date, deliverables, search_tsv)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${TSV})`,
        [id, d.code, d.name, d.client, d.description, d.scope, d.status, d.area, d.classification, d.ownerPersonId, d.dueDate, d.deliverables],
      );
      await this.writeMembers(tx, id, d.memberPersonIds);
      await tx.query('insert into proposal_history (id, proposal_id, by_user, change) values ($1, $2, $3, $4)', [randomUUID(), id, p.id, 'Proposta cadastrada']);
    });
    await this.audit.record({ actorId: p.id, action: 'proposal.created', targetType: 'proposal', targetId: id });
    return this.get(p, id);
  }

  async update(p: Principal, id: string, input: unknown): Promise<ProposalDTO> {
    assertCan(p, 'proposals:write');
    const current = await this.get(p, id);
    this.assertWritable(p, current);
    const parsed = ProposalInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('Dados inválidos', parsed.error.flatten());
    const d = parsed.data;
    this.assertWritable(p, d);
    const changes: string[] = [];
    if (current.status !== d.status) changes.push(`Status: ${PROPOSAL_STATUS_LABEL[current.status]} → ${PROPOSAL_STATUS_LABEL[d.status]}`);
    if (current.scope !== d.scope) changes.push('Escopo atualizado');
    if (current.ownerPersonId !== d.ownerPersonId) changes.push('Responsável alterado');
    if (current.dueDate !== d.dueDate) changes.push(`Prazo: ${current.dueDate ?? '—'} → ${d.dueDate ?? '—'}`);
    if (current.name !== d.name || current.description !== d.description) changes.push('Dados gerais atualizados');
    if (JSON.stringify(current.deliverables) !== JSON.stringify(d.deliverables)) changes.push('Entregáveis atualizados');
    if (JSON.stringify([...current.memberPersonIds].sort()) !== JSON.stringify([...d.memberPersonIds].sort())) changes.push('Equipe atualizada');
    await this.db.transaction(async (tx) => {
      await tx.query(
        `update proposals set code = $2, name = $3, client = $4, description = $5, scope = $6, status = $7, area = $8, classification = $9,
           owner_person_id = $10, due_date = $11, deliverables = $12, search_tsv = ${TSV}, updated_at = now() where id = $1`,
        [id, d.code, d.name, d.client, d.description, d.scope, d.status, d.area, d.classification, d.ownerPersonId, d.dueDate, d.deliverables],
      );
      await this.writeMembers(tx, id, d.memberPersonIds);
      for (const change of changes) await tx.query('insert into proposal_history (id, proposal_id, by_user, change) values ($1, $2, $3, $4)', [randomUUID(), id, p.id, change]);
    });
    await this.audit.record({ actorId: p.id, action: 'proposal.updated', targetType: 'proposal', targetId: id, metadata: { changes } });
    return this.get(p, id);
  }

  /**
   * Localiza propostas para o Proposal Agent: código exato (ex.: PRP-2025-014) tem prioridade;
   * depois full-text em nome, cliente, descrição e escopo. Sempre com ACL.
   */
  async find(p: Principal, query: string, limit = 3): Promise<ProposalMatch[]> {
    assertCan(p, 'proposals:read');
    const codes = [...query.toUpperCase().matchAll(/\b[A-Z]{2,6}-\d{2,4}(?:-\d{1,4})?\b/g)].map((m) => m[0]);
    const tsq = buildTsQuery(query);
    const acl = proposalAccessSql(p, 'pr', 3);
    const rows = await this.db.query<ProposalRow & { rank: number; code_hit: boolean }>(
      `select x.* from (
         ${selectSql(
           `, (pr.code = any($1::text[])) as code_hit, coalesce(ts_rank_cd(pr.search_tsv, tq.q), 0) as rank`,
           `cross join (select case when $2 = '' then null else to_tsquery('portuguese', $2) end as q) tq`,
         )}
         where ${acl.sql} and (pr.code = any($1::text[]) or (tq.q is not null and pr.search_tsv @@ tq.q))
       ) x order by x.code_hit desc, x.rank desc limit 10`,
      [codes, tsq ?? '', ...acl.params],
    );
    const anchors = anchorTerms(query);
    const hydrated = await this.hydrate(p, rows, true);
    return hydrated
      .map((proposal, i) => {
        const r = rows[i]!;
        const cov = termCoverage(anchors, `${proposal.code} ${proposal.name} ${proposal.client} ${proposal.description}`);
        return { proposal, score: (r.code_hit ? 10 : 0) + Number(r.rank) + cov * 2, strong: r.code_hit || cov >= 0.5 };
      })
      .filter((m) => m.strong)
      .map(({ proposal, score }) => ({ proposal, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
