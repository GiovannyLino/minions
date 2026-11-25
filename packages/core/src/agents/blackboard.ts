import type { PersonDTO, ProposalDTO } from '../contracts';
import type { Evidence } from '../knowledge/search';
import type { AgentResult, ExtractedStep } from './types';

/**
 * Memória compartilhada da requisição. Cada agente publica o que encontrou; os agentes seguintes
 * (e o Orchestrator) leem daqui — evitando buscas repetidas e permitindo complementar respostas.
 */
export class Blackboard {
  readonly evidence = new Map<string, Evidence>();
  readonly people = new Map<string, { person: PersonDTO; reason: string }>();
  readonly proposals = new Map<string, ProposalDTO>();
  readonly steps: { agent: string; step: ExtractedStep }[] = [];
  readonly findings: { agent: string; text: string; chunkId: string }[] = [];
  readonly results: AgentResult[] = [];

  publish(result: AgentResult): void {
    this.results.push(result);
    for (const e of result.evidence) {
      const prev = this.evidence.get(e.chunkId);
      if (!prev || prev.score < e.score) this.evidence.set(e.chunkId, e);
    }
    for (const p of result.people) {
      const prev = this.people.get(p.person.id);
      // Vínculo explícito (ex.: responsável pela proposta) vale mais que afinidade por tema.
      const explicit = (reason: string) => /\b(pela|da) proposta\b/i.test(reason);
      if (!prev || (explicit(p.reason) && !explicit(prev.reason))) this.people.set(p.person.id, p);
    }
    for (const pr of result.proposals) this.proposals.set(pr.id, pr);
    for (const step of result.steps) this.steps.push({ agent: result.agent, step });
    for (const f of result.findings) this.findings.push({ agent: result.agent, ...f });
  }

  /** Áreas responsáveis pelos documentos encontrados (usado pelo People Agent). */
  evidenceAreas(minRelevance: number): string[] {
    const counts = new Map<string, number>();
    for (const e of this.evidence.values()) if (e.relevance >= minRelevance) counts.set(e.area, (counts.get(e.area) ?? 0) + e.score);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  }

  relevantEvidence(minRelevance: number, limit = 8): Evidence[] {
    return [...this.evidence.values()]
      .filter((e) => e.relevance >= minRelevance)
      .sort((a, b) => b.relevance - a.relevance || b.score - a.score)
      .slice(0, limit);
  }
}
