/**
 * Contratos compartilhados entre API, núcleo e interfaces (web, Teams).
 * Este módulo é seguro para o navegador: apenas zod e tipos, sem dependências Node.
 */
import { z } from 'zod';

// ───────────────────────── Identidade e permissões ─────────────────────────

export const ROLES = ['admin', 'manager', 'collaborator'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const CLASSIFICATIONS = ['public', 'internal', 'restricted', 'confidential'] as const;
export const ClassificationSchema = z.enum(CLASSIFICATIONS);
export type Classification = z.infer<typeof ClassificationSchema>;

export const CLASSIFICATION_RANK: Record<Classification, number> = {
  public: 0,
  internal: 1,
  restricted: 2,
  confidential: 3,
};

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  public: 'Público interno',
  internal: 'Interno',
  restricted: 'Restrito',
  confidential: 'Confidencial',
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrador',
  manager: 'Gestor da base',
  collaborator: 'Colaborador',
};

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: RoleSchema,
  area: z.string().nullable(),
  groups: z.array(z.string()),
  clearance: ClassificationSchema,
  active: z.boolean(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type User = z.infer<typeof UserSchema>;

// ───────────────────────── Agentes ─────────────────────────

export const AGENT_IDS = ['orchestrator', 'knowledge', 'process', 'proposal', 'people'] as const;
export const AgentIdSchema = z.enum(AGENT_IDS);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const AGENT_META: Record<AgentId, { name: string; role: string; short: string }> = {
  orchestrator: { name: 'Orchestrator', role: 'Coordena os agentes e monta a resposta', short: 'OR' },
  knowledge: { name: 'Knowledge', role: 'Conceitos, políticas e documentos', short: 'KN' },
  process: { name: 'Process', role: 'Processos, sistemas e passo a passo', short: 'PR' },
  proposal: { name: 'Proposal', role: 'Propostas, projetos e escopos', short: 'PP' },
  people: { name: 'People', role: 'Responsáveis e especialistas', short: 'PE' },
};

export const IntentSchema = z.enum([
  'concept', // o que é / para que serve
  'procedure', // como fazer
  'proposal', // escopo/status/responsável de proposta
  'people', // com quem falar
  'document_lookup', // onde está o documento
  'general',
]);
export type Intent = z.infer<typeof IntentSchema>;

export const TraceEventSchema = z.object({
  type: z.enum(['plan', 'memory', 'agent_start', 'agent_end', 'agent_request', 'agent_skipped', 'synthesis', 'error', 'done']),
  at: z.string(),
  agent: AgentIdSchema.optional(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

// ───────────────────────── Resposta do chat ─────────────────────────

export const AnswerSourceSchema = z.object({
  ref: z.string(), // S1, S2...
  documentId: z.string(),
  versionId: z.string(),
  title: z.string(),
  version: z.number(),
  updatedAt: z.string(),
  page: z.number().nullable(),
  section: z.string().nullable(),
  excerpt: z.string(),
  classification: ClassificationSchema,
  suspicious: z.boolean().default(false),
  downloadUrl: z.string().nullable().optional(),
});
export type AnswerSource = z.infer<typeof AnswerSourceSchema>;

export const AnswerStepSchema = z.object({
  title: z.string(),
  detail: z.string(),
  citations: z.array(z.string()),
});
export type AnswerStep = z.infer<typeof AnswerStepSchema>;

export const AnswerPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  area: z.string().nullable(),
  email: z.string().nullable(),
  reason: z.string(),
});
export type AnswerPerson = z.infer<typeof AnswerPersonSchema>;

export const AnswerProposalSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  status: z.string(),
});

export const AnswerConflictSchema = z.object({
  description: z.string(),
  refs: z.array(z.string()),
});
export type AnswerConflict = z.infer<typeof AnswerConflictSchema>;

export const AgentContributionSchema = z.object({
  agent: AgentIdSchema,
  status: z.enum(['ok', 'empty', 'failed', 'skipped']),
  durationMs: z.number(),
  summary: z.string(),
});
export type AgentContribution = z.infer<typeof AgentContributionSchema>;

export const ChatAnswerSchema = z.object({
  status: z.enum(['answered', 'partial', 'insufficient']),
  /** llm = modelo de IA · extractive = trechos literais (sem IA) · memory = reaproveitada da memória de respostas */
  mode: z.enum(['llm', 'extractive', 'memory']),
  /** Presente quando a resposta veio da memória (nunca expõe a pergunta original). */
  memory: z.object({ createdAt: z.string(), similarity: z.number() }).optional(),
  intent: IntentSchema,
  summary: z.string(),
  steps: z.array(AnswerStepSchema),
  sources: z.array(AnswerSourceSchema),
  people: z.array(AnswerPersonSchema),
  proposals: z.array(AnswerProposalSchema),
  conflicts: z.array(AnswerConflictSchema),
  agents: z.array(AgentContributionSchema),
  suggestions: z.array(z.string()),
  nextActions: z.array(z.string()),
  traceId: z.string(),
  durationMs: z.number(),
});
export type ChatAnswer = z.infer<typeof ChatAnswerSchema>;

export const INSUFFICIENT_MESSAGE =
  'Não encontrei informações suficientes na base de conhecimento para responder com segurança.';

export const ChatRequestSchema = z.object({
  message: z.string().trim().min(2, 'Pergunta muito curta').max(4000, 'Pergunta muito longa'),
});

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().optional(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  answer: ChatAnswerSchema.nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

// ───────────────────────── Documentos ─────────────────────────

export const DOCUMENT_STATUSES = ['pending', 'processing', 'ready', 'failed', 'archived'] as const;
export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const DocumentMetadataInputSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).default(''),
  category: z.string().trim().min(1).max(80),
  area: z.string().trim().min(1).max(80),
  classification: ClassificationSchema.default('internal'),
  allowedGroups: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  /** Chave de assunto: documentos com a mesma chave e conteúdo divergente são comparados */
  subjectKey: z.string().trim().max(120).optional(),
  proposalId: z.string().uuid().optional(),
});
export type DocumentMetadataInput = z.infer<typeof DocumentMetadataInputSchema>;

export const DocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  area: z.string(),
  classification: ClassificationSchema,
  allowedGroups: z.array(z.string()),
  subjectKey: z.string().nullable(),
  status: DocumentStatusSchema,
  ownerId: z.string(),
  ownerName: z.string().nullable(),
  currentVersion: z.number(),
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  pageCount: z.number().nullable(),
  chunkCount: z.number(),
  flags: z.array(z.string()),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentDTO = z.infer<typeof DocumentSchema>;

export const DocumentVersionSchema = z.object({
  id: z.string(),
  version: z.number(),
  fileName: z.string(),
  sizeBytes: z.number(),
  status: DocumentStatusSchema,
  uploadedBy: z.string().nullable(),
  createdAt: z.string(),
  error: z.string().nullable(),
});
export type DocumentVersionDTO = z.infer<typeof DocumentVersionSchema>;

// ───────────────────────── Propostas e pessoas ─────────────────────────

export const PROPOSAL_STATUSES = ['draft', 'in_review', 'submitted', 'won', 'lost', 'cancelled'] as const;
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export const PROPOSAL_STATUS_LABEL: Record<z.infer<typeof ProposalStatusSchema>, string> = {
  draft: 'Em elaboração',
  in_review: 'Em revisão',
  submitted: 'Enviada',
  won: 'Ganha',
  lost: 'Perdida',
  cancelled: 'Cancelada',
};

export const ProposalInputSchema = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(200),
  client: z.string().trim().max(200).default(''),
  description: z.string().trim().max(4000).default(''),
  scope: z.string().trim().max(10000).default(''),
  status: ProposalStatusSchema.default('draft'),
  area: z.string().trim().min(1).max(80),
  classification: ClassificationSchema.default('restricted'),
  ownerPersonId: z.string().uuid().nullable().default(null),
  memberPersonIds: z.array(z.string().uuid()).max(50).default([]),
  dueDate: z.string().date().nullable().default(null),
  deliverables: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
});
export type ProposalInput = z.infer<typeof ProposalInputSchema>;

export const ProposalSchema = ProposalInputSchema.extend({
  id: z.string(),
  ownerName: z.string().nullable(),
  members: z.array(z.object({ id: z.string(), name: z.string(), jobTitle: z.string().nullable() })),
  documents: z.array(z.object({ id: z.string(), title: z.string(), category: z.string() })),
  history: z.array(z.object({ at: z.string(), by: z.string().nullable(), change: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProposalDTO = z.infer<typeof ProposalSchema>;

export const PersonInputSchema = z.object({
  name: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(200).nullable().default(null),
  jobTitle: z.string().trim().max(120).nullable().default(null),
  area: z.string().trim().min(1).max(80),
  expertise: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  responsibilities: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  /** Se false, o e-mail não é exibido nem usado pelos agentes */
  contactVisible: z.boolean().default(true),
  userId: z.string().uuid().nullable().default(null),
});
export type PersonInput = z.infer<typeof PersonInputSchema>;

export const PersonSchema = PersonInputSchema.extend({
  id: z.string(),
  proposals: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PersonDTO = z.infer<typeof PersonSchema>;

// ───────────────────────── Administração ─────────────────────────

export const AgentSettingsSchema = z.object({
  enabledAgents: z.array(AgentIdSchema.exclude(['orchestrator'])),
  maxAgentCalls: z.number().int().min(1).max(20),
  maxDepth: z.number().int().min(1).max(4),
  maxLlmCalls: z.number().int().min(0).max(20),
  timeoutMs: z.number().int().min(5000).max(180000),
  retrievalTopK: z.number().int().min(3).max(30),
  minRelevance: z.number().min(0).max(1),
  /** Memória de respostas: off · user (padrão, por usuário) · organization (compartilhada, só perguntas independentes) */
  answerMemory: z.enum(['off', 'user', 'organization']).default('user'),
  /** Similaridade mínima (cosseno) entre perguntas para reaproveitar uma resposta */
  memorySimilarity: z.number().min(0.8).max(1).default(0.92),
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

export const CategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  documentCount: z.number(),
});
export type CategoryDTO = z.infer<typeof CategorySchema>;

export const AuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  outcome: z.enum(['success', 'denied', 'error']),
  metadata: z.record(z.string(), z.unknown()),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const DashboardSchema = z.object({
  stats: z.object({
    documents: z.number(),
    readyDocuments: z.number(),
    chunks: z.number(),
    proposals: z.number(),
    people: z.number(),
    myConversations: z.number(),
    questionsLast7d: z.number(),
    answeredRateLast7d: z.number().nullable(),
  }),
  recentDocuments: z.array(DocumentSchema.pick({ id: true, title: true, category: true, area: true, status: true, updatedAt: true, currentVersion: true })),
  recentConversations: z.array(ConversationSchema),
  activity: z.array(z.object({ day: z.string(), questions: z.number(), uploads: z.number() })),
  aiMode: z.enum(['llm', 'extractive']),
  aiProvider: z.string().nullable(),
  offline: z.boolean(),
  realDataAllowed: z.boolean(),
});
export type DashboardDTO = z.infer<typeof DashboardSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
