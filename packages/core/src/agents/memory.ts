import { randomUUID } from 'node:crypto';
import { ChatAnswerSchema, type ChatAnswer } from '../contracts';
import { documentAccessSql, type Principal } from '../auth/policy';
import { toVectorLiteral, type Db } from '../db/client';
import type { PeopleService } from '../directory/people';

export type MemoryScope = 'off' | 'user' | 'organization';

export interface MemoryHit {
  id: string;
  answer: ChatAnswer;
  similarity: number;
  createdAt: string;
  originalQuestion: string;
}

/**
 * Memória de respostas (cache semântico). Permite responder perguntas repetidas sem modelo de IA,
 * inclusive offline. Garantias:
 * - só reaproveita se TODAS as fontes continuam na mesma versão, ativas e acessíveis ao usuário atual;
 * - contatos são recarregados do diretório (visibilidade atual), nunca copiados da resposta antiga;
 * - respostas com propostas não são memorizadas (status/escopo mudam com frequência);
 * - escopo "user" (padrão) nunca compartilha entre usuários; "organization" compartilha apenas
 *   perguntas independentes de contexto.
 */
export class AnswerMemoryService {
  constructor(
    private readonly db: Db,
    private readonly people: PeopleService,
  ) {}

  async recall(p: Principal, queryVector: number[], opts: { scope: MemoryScope; minSimilarity: number }): Promise<MemoryHit | null> {
    if (opts.scope === 'off') return null;
    const candidates = await this.db.query<{ id: string; question: string; answer: unknown; source_versions: string[]; sim: number; created_at: Date }>(
      `select id, question, answer, source_versions, created_at, 1 - (question_embedding <=> $1::vector) as sim
       from answer_memory
       where owner_id = $2 or ($3 = 'organization' and standalone)
       order by question_embedding <=> $1::vector
       limit 5`,
      [toVectorLiteral(queryVector), p.id, opts.scope],
    );
    for (const c of candidates) {
      if (Number(c.sim) < opts.minSimilarity) break;
      const parsed = ChatAnswerSchema.safeParse(c.answer);
      if (!parsed.success || !(await this.sourcesStillValid(p, c.source_versions))) continue;
      const answer = parsed.data;
      // Contatos: estado atual do diretório (e-mail só se ainda autorizado).
      const current = new Map((await this.people.getMany(answer.people.map((x) => x.id))).map((x) => [x.id, x]));
      answer.people = answer.people
        .filter((x) => current.has(x.id))
        .map((x) => {
          const now = current.get(x.id)!;
          return { ...x, name: now.name, jobTitle: now.jobTitle, area: now.area, email: now.email };
        });
      await this.db.query('update answer_memory set hits = hits + 1, last_used_at = now() where id = $1', [c.id]);
      return { id: c.id, answer, similarity: Number(c.sim), createdAt: new Date(c.created_at).toISOString(), originalQuestion: c.question };
    }
    return null;
  }

  /** Confere que cada versão usada ainda é a versão atual de um documento ativo e visível ao usuário. */
  private async sourcesStillValid(p: Principal, versionIds: string[]): Promise<boolean> {
    if (versionIds.length === 0) return false;
    const acl = documentAccessSql(p, 'd', 2);
    const row = await this.db.one<{ n: number }>(
      `select count(*)::int as n from documents d where d.current_version_id = any($1::uuid[]) and d.status = 'ready' and ${acl.sql}`,
      [versionIds, ...acl.params],
    );
    return (row?.n ?? 0) === new Set(versionIds).size;
  }

  async remember(p: Principal, question: string, queryVector: number[], answer: ChatAnswer, standalone: boolean): Promise<void> {
    if (answer.status === 'insufficient' || answer.sources.length === 0 || answer.proposals.length > 0 || answer.mode === 'memory') return;
    const stored: ChatAnswer = { ...answer, sources: answer.sources.map((s) => ({ ...s, downloadUrl: null })) };
    await this.db.query(
      `insert into answer_memory (id, owner_id, question, question_embedding, answer, source_versions, standalone) values ($1, $2, $3, $4::vector, $5, $6, $7)`,
      [randomUUID(), p.id, question.slice(0, 2000), toVectorLiteral(queryVector), JSON.stringify(stored), [...new Set(answer.sources.map((s) => s.versionId))], standalone],
    );
  }

  async stats(): Promise<{ entries: number; hits: number }> {
    const row = await this.db.one<{ entries: number; hits: number }>('select count(*)::int as entries, coalesce(sum(hits), 0)::int as hits from answer_memory');
    return row ?? { entries: 0, hits: 0 };
  }

  async clear(): Promise<number> {
    return (await this.db.query<{ id: string }>('delete from answer_memory returning id')).length;
  }
}
