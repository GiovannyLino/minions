import type { AgentId, AgentSettings, Intent, PersonDTO, ProposalDTO, TraceEvent } from '../contracts';
import type { Principal } from '../auth/policy';
import type { LlmProvider } from '../ai/llm';
import type { Evidence, SearchOptions } from '../knowledge/search';
import type { PersonMatch } from '../directory/people';
import type { ProposalMatch } from '../directory/proposals';
import type { ExecutionBudget } from './budget';
import type { Blackboard } from './blackboard';

export type WorkerAgentId = Exclude<AgentId, 'orchestrator'>;

/** Pedido de trabalho para um agente. Sempre emitido/aprovado pelo Orchestrator. */
export interface AgentTask {
  id: string;
  agent: WorkerAgentId;
  objective: string;
  query: string;
  requestedBy: AgentId;
  depth: number;
  hints?: AgentHints;
}

export interface AgentHints {
  areas?: string[];
  personIds?: string[];
  proposalIds?: string[];
  topic?: string;
}

/** Pedido de colaboração de um agente a outro (o Orchestrator decide se despacha). */
export interface AgentRequest {
  to: WorkerAgentId;
  objective: string;
  query: string;
  reason: string;
  hints?: AgentHints;
}

export interface ExtractedStep {
  title: string;
  detail: string;
  chunkIds: string[];
}

export interface AgentResult {
  agent: WorkerAgentId;
  taskId: string;
  status: 'ok' | 'empty' | 'failed';
  summary: string;
  /** Afirmações extraídas literalmente dos trechos (com o chunk de origem). */
  findings: { text: string; chunkId: string }[];
  evidence: Evidence[];
  steps: ExtractedStep[];
  people: { person: PersonDTO; reason: string }[];
  proposals: ProposalDTO[];
  requests: AgentRequest[];
  durationMs: number;
  reused?: boolean;
}

/**
 * Ferramentas disponíveis aos agentes. Todas já estão vinculadas ao usuário da requisição —
 * não existe forma de um agente consultar dados sem a autorização do usuário.
 */
export interface AgentTools {
  searchKnowledge(query: string, opts?: SearchOptions): Promise<Evidence[]>;
  findProposals(query: string): Promise<ProposalMatch[]>;
  findExperts(topic: string, areas?: string[]): Promise<PersonMatch[]>;
  getPeople(ids: string[]): Promise<PersonDTO[]>;
}

export interface AgentContext {
  principal: Principal;
  question: string;
  intent: Intent;
  intents: Intent[];
  tools: AgentTools;
  blackboard: Blackboard;
  budget: ExecutionBudget;
  settings: AgentSettings;
  llm: LlmProvider | null;
  signal: AbortSignal;
  emit(event: Omit<TraceEvent, 'at'>): void;
}

export interface Agent {
  readonly id: WorkerAgentId;
  run(task: AgentTask, ctx: AgentContext): Promise<Omit<AgentResult, 'durationMs' | 'taskId' | 'agent'>>;
}

export const emptyResult = (summary: string): Omit<AgentResult, 'durationMs' | 'taskId' | 'agent'> => ({
  status: 'empty',
  summary,
  findings: [],
  evidence: [],
  steps: [],
  people: [],
  proposals: [],
  requests: [],
});
