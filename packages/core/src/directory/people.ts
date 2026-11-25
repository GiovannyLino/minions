import { randomUUID } from 'node:crypto';
import { PersonInputSchema, type PersonDTO } from '../contracts';
import type { AuditService } from '../audit/audit';
import { assertCan, type Principal } from '../auth/policy';
import { iso, type Db } from '../db/client';
import { NotFoundError, ValidationError } from '../errors';
import { anchorTerms, buildTsQuery, termCoverage } from '../knowledge/search';

interface PersonRow {
  id: string;
  name: string;
  email: string | null;
  job_title: string | null;
  area: string;
  expertise: string[];
  responsibilities: string[];
  contact_visible: boolean;
  user_id: string | null;
  created_at: Date;
  updated_at: Date;
  proposals: { id: string; code: string; name: string }[] | null;
}

const toDto = (r: PersonRow): PersonDTO => ({
  id: r.id,
  name: r.name,
  // Contato só é exposto quando autorizado (LGPD: minimização).
  email: r.contact_visible ? r.email : null,
  jobTitle: r.job_title,
  area: r.area,
  expertise: r.expertise ?? [],
  responsibilities: r.responsibilities ?? [],
  contactVisible: r.contact_visible,
  userId: r.user_id,
  proposals: r.proposals ?? [],
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const PROPOSALS_OF_PERSON = `(
    select coalesce(json_agg(json_build_object('id', pr.id, 'code', pr.code, 'name', pr.name)), '[]'::json)
    from proposals pr where pr.owner_person_id = p.id or exists (select 1 from proposal_members m where m.proposal_id = pr.id and m.person_id = p.id)
  ) as proposals`;

const SELECT = `select p.*, ${PROPOSALS_OF_PERSON} from people p`;

const TSV = `setweight(to_tsvector('portuguese', unaccent($2)), 'B') || setweight(to_tsvector('portuguese', unaccent($5 || ' ' || coalesce($4, ''))), 'B') || setweight(to_tsvector('portuguese', unaccent(array_to_string($6::text[], ' '))), 'A') || setweight(to_tsvector('portuguese', unaccent(array_to_string($7::text[], ' '))), 'A')`;

export interface PersonMatch {
  person: PersonDTO;
  score: number;
  reason: string;
}

export class PeopleService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(p: Principal, q?: string, area?: string): Promise<PersonDTO[]> {
    assertCan(p, 'people:read');
    const params: unknown[] = [];
    const where: string[] = [];
    if (area) {
      params.push(area);
      where.push(`p.area = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.replace(/[%_]/g, '')}%`);
      const n = params.length;
      where.push(`(p.name ilike $${n} or p.area ilike $${n} or p.job_title ilike $${n} or array_to_string(p.expertise, ' ') ilike $${n} or array_to_string(p.responsibilities, ' ') ilike $${n})`);
    }
    const rows = await this.db.query<PersonRow>(`${SELECT} ${where.length ? `where ${where.join(' and ')}` : ''} order by p.name limit 500`, params);
    return rows.map(toDto);
  }

  async get(p: Principal, id: string): Promise<PersonDTO> {
    assertCan(p, 'people:read');
    const row = await this.db.one<PersonRow>(`${SELECT} where p.id = $1`, [id]).catch(() => undefined);
    if (!row) throw new NotFoundError('Pessoa não encontrada');
    return toDto(row);
  }

  async getMany(ids: string[]): Promise<PersonDTO[]> {
    if (!ids.length) return [];
    return (await this.db.query<PersonRow>(`${SELECT} where p.id = any($1::uuid[])`, [ids])).map(toDto);
  }

  async create(p: Principal, input: unknown): Promise<PersonDTO> {
    assertCan(p, 'people:write');
    const parsed = PersonInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('Dados inválidos', parsed.error.flatten());
    const d = parsed.data;
    const id = randomUUID();
    await this.db.query(
      `insert into people (id, name, email, job_title, area, expertise, responsibilities, contact_visible, user_id, search_tsv)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${TSV})`,
      [id, d.name, d.email, d.jobTitle, d.area, d.expertise, d.responsibilities, d.contactVisible, d.userId],
    );
    await this.audit.record({ actorId: p.id, action: 'person.created', targetType: 'person', targetId: id });
    return this.get(p, id);
  }

  async update(p: Principal, id: string, input: unknown): Promise<PersonDTO> {
    assertCan(p, 'people:write');
    await this.get(p, id);
    const parsed = PersonInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError('Dados inválidos', parsed.error.flatten());
    const d = parsed.data;
    await this.db.query(
      `update people set name = $2, email = $3, job_title = $4, area = $5, expertise = $6, responsibilities = $7, contact_visible = $8, user_id = $9,
       search_tsv = ${TSV}, updated_at = now() where id = $1`,
      [id, d.name, d.email, d.jobTitle, d.area, d.expertise, d.responsibilities, d.contactVisible, d.userId],
    );
    await this.audit.record({ actorId: p.id, action: 'person.updated', targetType: 'person', targetId: id });
    return this.get(p, id);
  }

  async remove(p: Principal, id: string): Promise<void> {
    assertCan(p, 'people:write');
    await this.get(p, id);
    await this.db.query('delete from people where id = $1', [id]);
    await this.audit.record({ actorId: p.id, action: 'person.deleted', targetType: 'person', targetId: id });
  }

  /**
   * Encontra especialistas/responsáveis por tema e/ou área. Usado pelo People Agent.
   * Pontua por especialidades e responsabilidades (peso maior) e área.
   */
  async findExperts(p: Principal, topic: string, opts: { areas?: string[]; limit?: number } = {}): Promise<PersonMatch[]> {
    assertCan(p, 'people:read');
    const tsq = buildTsQuery(topic);
    const areas = (opts.areas ?? []).map((a) => a.toLowerCase());
    const rows = await this.db.query<PersonRow & { rank: number }>(
      `select p.*, ${PROPOSALS_OF_PERSON}, coalesce(ts_rank_cd(p.search_tsv, tq.q), 0) as rank
       from people p, (select case when $1 = '' then null else to_tsquery('portuguese', $1) end as q) tq
       where (tq.q is not null and p.search_tsv @@ tq.q) or lower(p.area) = any($2::text[])
       order by rank desc limit 30`,
      [tsq ?? '', areas],
    );
    const terms = anchorTerms(topic);
    const matches = rows.map((r) => {
      const dto = toDto(r);
      const expertiseText = `${dto.expertise.join(' ')} ${dto.responsibilities.join(' ')}`;
      const cov = terms.length ? termCoverage(terms, expertiseText) : 0;
      const areaHit = areas.includes(dto.area.toLowerCase());
      const score = Number(r.rank) + cov * 2 + (areaHit ? 1 : 0);
      const matched = [...dto.responsibilities, ...dto.expertise].filter((x) => termCoverage(terms, x) > 0).slice(0, 2);
      const reason = matched.length
        ? `Responsável/especialista em ${matched.join('; ')}`
        : areaHit
          ? `Atua na área ${dto.area}`
          : `Perfil relacionado ao tema`;
      return { person: dto, score, reason, topical: cov > 0, areaHit };
    });
    // Prioriza quem tem o tema nas especialidades/responsabilidades; só área quando ninguém cobre o tema.
    const topical = matches.filter((m) => m.topical);
    const pool = topical.length ? [...topical, ...matches.filter((m) => !m.topical && m.areaHit).slice(0, 1)] : matches.filter((m) => m.areaHit);
    return pool
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 3)
      .map(({ person, score, reason }) => ({ person, score, reason }));
  }
}
