import type { Classification } from '../contracts';
import { documentAccessSql, type Principal } from '../auth/policy';
import { iso, toVectorLiteral, type Db } from '../db/client';
import type { EmbeddingProvider } from '../ai/embeddings';
import { stripAccents, tokenize } from './text';

/** Trecho recuperado, já autorizado para o usuário da requisição. */
export interface Evidence {
  chunkId: string;
  documentId: string;
  versionId: string;
  title: string;
  category: string;
  area: string;
  classification: Classification;
  version: number;
  updatedAt: string;
  page: number | null;
  section: string | null;
  content: string;
  suspicious: boolean;
  subjectKey: string | null;
  proposalId: string | null;
  /** Fusão RRF (ordem) */
  score: number;
  /** Similaridade de cosseno (0..1) */
  similarity: number;
  /** Cobertura dos termos-âncora da pergunta no trecho (0..1) */
  coverage: number;
  /** Relevância absoluta usada no corte de suficiência */
  relevance: number;
}

export interface SearchOptions {
  topK?: number;
  categories?: string[];
  documentIds?: string[];
  proposalId?: string;
  /** Multiplicador de score para categorias (ex.: Process Agent prioriza "Procedimento") */
  categoryBoost?: Record<string, number>;
}

/** Verbos/termos genéricos que não identificam o assunto da pergunta. */
const GENERIC_TERMS = new Set(
  (
    'abrir abro abre fazer preencher preencho usar utilizar uso solicitar pedir encontrar achar localizar explicar explique entender ' +
    'serve servem funciona funcionamento significa significado definicao conceito procedimento processo passo passos etapa etapas ' +
    'responsavel responsaveis contato falar duvida duvidas tirar onde fica esta atual status documento documentos arquivo modelo ' +
    'informacao informacoes empresa trabalho area setor sistema'
  ).split(/\s+/),
);

/** Termos da pergunta que carregam o assunto (siglas, nomes, substantivos específicos). */
export function anchorTerms(query: string): string[] {
  const toks = tokenize(query);
  const anchors = toks.filter((t) => !GENERIC_TERMS.has(t));
  return [...new Set(anchors.length > 0 ? anchors : toks)];
}

const stem = (t: string) => t.slice(0, Math.max(4, Math.min(6, t.length)));

export function termCoverage(anchors: string[], text: string): number {
  if (anchors.length === 0) return 0;
  const tokens = tokenize(text);
  const exact = new Set(tokens);
  const stems = new Set(tokens.map(stem));
  const normalized = stripAccents(text.toLowerCase());
  let hit = 0;
  for (const a of anchors) {
    if (exact.has(a) || (a.length >= 5 && stems.has(stem(a))) || (a.includes('-') && normalized.includes(a))) hit++;
  }
  return hit / anchors.length;
}

/** Monta uma tsquery OR a partir dos termos (sanitizados) — perguntas naturais raramente casam com AND. */
export function buildTsQuery(query: string): string | null {
  const parts = tokenize(query)
    .flatMap((t) => (t.includes('-') ? [t.split('-').filter((x) => x.length > 1).join(' & ')] : [t]))
    .map((t) => t.replace(/[^a-z0-9 &]/g, '').trim())
    .filter(Boolean)
    .map((t) => (t.includes('&') ? `(${t})` : `${t}:*`));
  return parts.length ? [...new Set(parts)].join(' | ') : null;
}

/**
 * Busca híbrida: vetorial (pgvector, cosseno) + full-text (português, sem acentos), fundidas por
 * Reciprocal Rank Fusion. A cláusula de ACL é aplicada em AMBOS os ramos, no SQL.
 */
export async function hybridSearch(db: Db, embeddings: EmbeddingProvider, p: Principal, query: string, opts: SearchOptions = {}): Promise<Evidence[]> {
  const topK = opts.topK ?? 8;
  const [qVec] = await embeddings.embed([query], 'query');
  const tsq = buildTsQuery(query);
  const acl = documentAccessSql(p, 'd', 4);
  const params: unknown[] = [toVectorLiteral(qVec!), tsq ?? '', Math.max(topK * 5, 30), ...acl.params];
  const filters: string[] = [`d.status = 'ready'`, acl.sql];
  if (opts.categories?.length) {
    params.push(opts.categories);
    filters.push(`d.category = any($${params.length}::text[])`);
  }
  if (opts.documentIds?.length) {
    params.push(opts.documentIds);
    filters.push(`d.id = any($${params.length}::uuid[])`);
  }
  if (opts.proposalId) {
    params.push(opts.proposalId);
    filters.push(`d.proposal_id = $${params.length}::uuid`);
  }

  const sql = `
    with allowed as (
      select d.id, d.current_version_id from documents d where ${filters.join(' and ')}
    ),
    vec as (
      select c.id, row_number() over (order by c.embedding <=> $1::vector) as r, 1 - (c.embedding <=> $1::vector) as sim
      from chunks c join allowed a on a.id = c.document_id and c.version_id = a.current_version_id
      order by c.embedding <=> $1::vector limit $3
    ),
    fts as (
      select c.id, row_number() over (order by ts_rank_cd(c.tsv, q) desc) as r
      from chunks c join allowed a on a.id = c.document_id and c.version_id = a.current_version_id,
           (select case when $2 = '' then null else to_tsquery('portuguese', $2) end as q) tq
      where tq.q is not null and c.tsv @@ tq.q
      order by ts_rank_cd(c.tsv, q) desc limit $3
    ),
    fused as (
      select coalesce(vec.id, fts.id) as id,
             coalesce(1.0 / (60 + vec.r), 0) + coalesce(1.0 / (60 + fts.r), 0) as score,
             coalesce(vec.sim, 0) as sim
      from vec full outer join fts on fts.id = vec.id
    )
    select c.id as chunk_id, c.document_id, c.version_id, c.content, c.page, c.section, c.suspicious,
           d.title, d.category, d.area, d.classification, d.subject_key, d.proposal_id, d.updated_at, v.version,
           f.score, f.sim,
           (select 1 - (c.embedding <=> $1::vector)) as exact_sim
    from fused f
    join chunks c on c.id = f.id
    join documents d on d.id = c.document_id
    join document_versions v on v.id = c.version_id
    order by f.score desc
    limit $3`;

  const rows = await db.query<{
    chunk_id: string; document_id: string; version_id: string; content: string; page: number | null; section: string | null; suspicious: boolean;
    title: string; category: string; area: string; classification: Classification; subject_key: string | null; proposal_id: string | null; updated_at: Date; version: number;
    score: number; sim: number; exact_sim: number;
  }>(sql, params);

  const anchors = anchorTerms(query);
  const evidence = rows.map((r): Evidence => {
    const coverage = termCoverage(anchors, `${r.title} ${r.section ?? ''} ${r.content}`);
    const similarity = Math.max(0, Number(r.exact_sim ?? r.sim ?? 0));
    // Relevância absoluta: termos-âncora presentes; similaridade alta cobre paráfrases (embeddings semânticos).
    const relevance = Math.max(coverage, similarity >= 0.6 ? similarity : 0);
    const boost = opts.categoryBoost?.[r.category] ?? 1;
    return {
      chunkId: r.chunk_id,
      documentId: r.document_id,
      versionId: r.version_id,
      title: r.title,
      category: r.category,
      area: r.area,
      classification: r.classification,
      version: r.version,
      updatedAt: iso(r.updated_at),
      page: r.page,
      section: r.section,
      content: r.content,
      suspicious: r.suspicious,
      subjectKey: r.subject_key,
      proposalId: r.proposal_id,
      score: Number(r.score) * boost * (0.5 + coverage),
      similarity,
      coverage,
      relevance,
    };
  });
  return evidence.sort((a, b) => b.score - a.score).slice(0, topK);
}
