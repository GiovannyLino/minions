import { randomUUID } from 'node:crypto';
import type { Principal } from '../auth/policy';
import { tokenize } from '../knowledge/text';
import { BudgetExceededError } from './budget';
import type { Agent, AgentContext, AgentResult, AgentTask, WorkerAgentId } from './types';

/**
 * Cache de resultados por usuário + conversa (TTL curto). Permite reaproveitar o que já foi encontrado
 * na mesma sessão sem nunca compartilhar resultados entre usuários. A chave inclui a "impressão" das
 * permissões do usuário: se o papel/grupos mudarem, o cache antigo deixa de valer.
 */
export class SessionResultCache {
  private readonly entries = new Map<string, { at: number; result: AgentResult }>();
  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 500,
  ) {}

  static scope(p: Principal, conversationId: string): string {
    return `${p.id}|${p.role}|${p.clearance}|${[...p.groups].sort().join(',')}|${conversationId}`;
  }

  get(scope: string, signature: string): AgentResult | undefined {
    const key = `${scope}#${signature}`;
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.result;
  }

  set(scope: string, signature: string, result: AgentResult): void {
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(`${scope}#${signature}`, { at: Date.now(), result });
  }

  clear(): void {
    this.entries.clear();
  }
}

export function taskSignature(agent: WorkerAgentId, query: string, hints?: AgentTask['hints']): string {
  const q = [...new Set(tokenize(query))].sort().join(' ');
  const h = hints
    ? JSON.stringify({ a: [...(hints.areas ?? [])].sort(), p: [...(hints.personIds ?? [])].sort(), r: [...(hints.proposalIds ?? [])].sort() })
    : '';
  return `${agent}:${q}:${h}`;
}

/**
 * Barramento de agentes: único caminho para executar um agente. Aplica orçamento, profundidade,
 * detecção de ciclos/duplicatas, timeout, reaproveitamento e rastreabilidade.
 */
export class AgentBus {
  private readonly seen = new Set<string>();

  constructor(
    private readonly agents: Map<WorkerAgentId, Agent>,
    private readonly cache: SessionResultCache,
    private readonly cacheScope: string,
  ) {}

  createTask(agent: WorkerAgentId, objective: string, query: string, requestedBy: AgentTask['requestedBy'], depth: number, hints?: AgentTask['hints']): AgentTask {
    return { id: randomUUID(), agent, objective, query, requestedBy, depth, hints };
  }

  async dispatch(task: AgentTask, ctx: AgentContext): Promise<AgentResult | null> {
    const agent = this.agents.get(task.agent);
    if (!agent || !ctx.settings.enabledAgents.includes(task.agent)) {
      ctx.emit({ type: 'agent_skipped', agent: task.agent, message: 'Agente desabilitado nas configurações' });
      return null;
    }
    const signature = taskSignature(task.agent, task.query, task.hints);
    if (this.seen.has(signature)) {
      ctx.emit({ type: 'agent_skipped', agent: task.agent, message: 'Tarefa equivalente já executada nesta pergunta (ciclo evitado)' });
      return null;
    }
    this.seen.add(signature);

    const cached = this.cache.get(this.cacheScope, signature);
    if (cached) {
      const reused = { ...cached, taskId: task.id, reused: true, durationMs: 0 };
      ctx.emit({ type: 'agent_end', agent: task.agent, message: `Resultado reaproveitado da conversa: ${cached.summary}`, data: { reused: true } });
      ctx.blackboard.publish(reused);
      return reused;
    }

    try {
      ctx.budget.consumeAgentCall(task.depth);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        ctx.emit({ type: 'agent_skipped', agent: task.agent, message: `Limite de execução (${err.resource})` });
        return null;
      }
      throw err;
    }

    ctx.emit({ type: 'agent_start', agent: task.agent, message: task.objective, data: { requestedBy: task.requestedBy, depth: task.depth } });
    const started = Date.now();
    let result: AgentResult;
    try {
      const timeout = Math.min(ctx.budget.remainingMs(), 30_000);
      const partial = await withTimeout(agent.run(task, ctx), timeout, ctx.signal);
      result = { ...partial, agent: task.agent, taskId: task.id, durationMs: Date.now() - started };
      if (result.status !== 'failed') this.cache.set(this.cacheScope, signature, result);
    } catch (err) {
      result = {
        agent: task.agent,
        taskId: task.id,
        status: 'failed',
        summary: err instanceof Error && err.name === 'TimeoutError' ? 'Tempo esgotado' : 'Falha ao executar o agente',
        findings: [],
        evidence: [],
        steps: [],
        people: [],
        proposals: [],
        requests: [],
        durationMs: Date.now() - started,
      };
      ctx.emit({ type: 'error', agent: task.agent, message: result.summary });
    }
    ctx.blackboard.publish(result);
    ctx.emit({
      type: 'agent_end',
      agent: task.agent,
      message: result.summary,
      data: { status: result.status, evidence: result.evidence.length, requests: result.requests.length, ms: result.durationMs },
    });
    return result;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('timeout');
      e.name = 'TimeoutError';
      reject(e);
    }, Math.max(1, ms));
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
