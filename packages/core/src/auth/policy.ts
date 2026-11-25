import { CLASSIFICATION_RANK, type Classification, type Role } from '../contracts';
import { ForbiddenError } from '../errors';

/** Usuário autenticado, carregado do banco a cada requisição (mudanças de papel valem imediatamente). */
export interface Principal {
  id: string;
  email: string;
  name: string;
  role: Role;
  area: string | null;
  groups: string[];
  clearance: Classification;
}

export const ACTIONS = [
  'chat:ask',
  'documents:read',
  'documents:upload',
  'documents:update',
  'documents:archive',
  'documents:purge',
  'proposals:read',
  'proposals:write',
  'people:read',
  'people:write',
  'admin:users',
  'admin:settings',
  'admin:audit',
  'admin:categories',
  'admin:ingestion',
] as const;
export type Action = (typeof ACTIONS)[number];

const COLLABORATOR: Action[] = ['chat:ask', 'documents:read', 'proposals:read', 'people:read'];
const MANAGER: Action[] = [
  ...COLLABORATOR,
  'documents:upload',
  'documents:update',
  'documents:archive',
  'proposals:write',
  'people:write',
  'admin:categories',
  'admin:ingestion',
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Action>> = {
  collaborator: new Set(COLLABORATOR),
  manager: new Set(MANAGER),
  admin: new Set(ACTIONS),
};

export function can(p: Principal, action: Action): boolean {
  return ROLE_PERMISSIONS[p.role].has(action);
}

export function assertCan(p: Principal, action: Action): void {
  if (!can(p, action)) throw new ForbiddenError();
}

/** Grupos efetivos: grupos do IdP + área do usuário. */
export function effectiveGroups(p: Principal): string[] {
  return [...new Set([...p.groups, ...(p.area ? [p.area] : [])].map((g) => g.toLowerCase()))];
}

export interface AccessControlled {
  classification: Classification;
  allowedGroups: string[];
}

/** Regra de leitura de documento (espelha `documentAccessSql`). */
export function canReadDocument(p: Principal, doc: AccessControlled): boolean {
  if (p.role === 'admin') return true;
  if (CLASSIFICATION_RANK[doc.classification] > CLASSIFICATION_RANK[p.clearance]) return false;
  if (doc.allowedGroups.length === 0) return true;
  const mine = new Set(effectiveGroups(p));
  return doc.allowedGroups.some((g) => mine.has(g.toLowerCase()));
}

/** Gestor só administra documentos da própria área (ou de grupos a que pertence). */
export function canManageDocument(p: Principal, doc: { area: string; ownerId: string }): boolean {
  if (p.role === 'admin') return true;
  if (p.role !== 'manager') return false;
  return doc.ownerId === p.id || effectiveGroups(p).includes(doc.area.toLowerCase());
}

const RANK_SQL = (col: string) =>
  `(case ${col} when 'public' then 0 when 'internal' then 1 when 'restricted' then 2 else 3 end)`;

/**
 * Cláusula SQL de autorização para documentos (e, por extensão, seus trechos).
 * TODA consulta de documentos/trechos deve incluir esta cláusula — é ela que impede um agente
 * de recuperar conteúdo que o usuário não pode ver.
 *
 * @param alias alias da tabela `documents` na consulta
 * @param firstParam índice do primeiro placeholder ($n) livre
 */
export function documentAccessSql(p: Principal, alias: string, firstParam: number): { sql: string; params: unknown[] } {
  if (p.role === 'admin') return { sql: 'true', params: [] };
  const a = firstParam;
  return {
    sql: `(${RANK_SQL(`${alias}.classification`)} <= $${a} and (cardinality(${alias}.allowed_groups) = 0 or exists (select 1 from unnest(${alias}.allowed_groups) g where lower(g) = any($${a + 1}::text[]))))`,
    params: [CLASSIFICATION_RANK[p.clearance], effectiveGroups(p)],
  };
}

/**
 * Cláusula SQL de autorização para propostas: habilitação suficiente e, se restrita/confidencial,
 * pertencer à área da proposta ou estar vinculado a ela (responsável/membro).
 */
export function proposalAccessSql(p: Principal, alias: string, firstParam: number): { sql: string; params: unknown[] } {
  if (p.role === 'admin') return { sql: 'true', params: [] };
  const a = firstParam;
  return {
    sql: `(${RANK_SQL(`${alias}.classification`)} <= $${a} and (${RANK_SQL(`${alias}.classification`)} <= 1 or lower(${alias}.area) = any($${a + 1}::text[]) or exists (
      select 1 from people pp where pp.user_id = $${a + 2}::uuid and (pp.id = ${alias}.owner_person_id or exists (select 1 from proposal_members pm where pm.proposal_id = ${alias}.id and pm.person_id = pp.id))
    )))`,
    params: [CLASSIFICATION_RANK[p.clearance], effectiveGroups(p), p.id],
  };
}

export function defaultClearance(role: Role): Classification {
  return role === 'admin' ? 'confidential' : role === 'manager' ? 'restricted' : 'internal';
}
