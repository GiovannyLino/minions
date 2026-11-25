export class BudgetExceededError extends Error {
  constructor(public readonly resource: 'agent_calls' | 'llm_calls' | 'depth' | 'time') {
    super(`Limite de execução atingido: ${resource}`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Limites de execução por pergunta: número de chamadas de agentes, chamadas ao modelo,
 * profundidade de colaboração e prazo total. Impede ciclos e custos descontrolados.
 */
export class ExecutionBudget {
  private agentCalls = 0;
  private llmCalls = 0;
  readonly deadline: number;

  constructor(
    readonly limits: { maxAgentCalls: number; maxLlmCalls: number; maxDepth: number; timeoutMs: number },
    now = Date.now(),
  ) {
    this.deadline = now + limits.timeoutMs;
  }

  get usage() {
    return { agentCalls: this.agentCalls, llmCalls: this.llmCalls, remainingMs: this.remainingMs() };
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  canCallAgent(depth: number): { ok: true } | { ok: false; reason: BudgetExceededError['resource'] } {
    if (depth > this.limits.maxDepth) return { ok: false, reason: 'depth' };
    if (this.agentCalls >= this.limits.maxAgentCalls) return { ok: false, reason: 'agent_calls' };
    if (this.remainingMs() <= 0) return { ok: false, reason: 'time' };
    return { ok: true };
  }

  consumeAgentCall(depth: number): void {
    const check = this.canCallAgent(depth);
    if (!check.ok) throw new BudgetExceededError(check.reason);
    this.agentCalls++;
  }

  /** Retorna false quando não há mais orçamento de LLM (o chamador usa o caminho determinístico). */
  tryConsumeLlmCall(): boolean {
    if (this.llmCalls >= this.limits.maxLlmCalls || this.remainingMs() < 3000) return false;
    this.llmCalls++;
    return true;
  }
}
