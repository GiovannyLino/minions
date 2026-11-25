import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { Logger } from '../logging/logger';

export type Effort = 'low' | 'medium' | 'high';

export interface StructuredRequest<T> {
  /** Identifica a chamada em logs/métricas (ex.: "orchestrator.plan"). */
  purpose: string;
  system: string;
  user: string;
  /** JSON Schema estrito (additionalProperties: false, todos os campos em required). */
  schema: Record<string, unknown>;
  validator: z.ZodType<T>;
  effort: Effort;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  generateJson<T>(req: StructuredRequest<T>): Promise<T>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Claude via Messages API com saída estruturada.
 * - Pensamento adaptativo (padrão do modelo); profundidade controlada por `effort`.
 * - Fallback de recusa do lado do servidor habilitado por padrão (`fallbacks: "default"`).
 * - Nenhum uso de Files API ou estado no provedor: só os trechos já autorizados são enviados.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly id = 'anthropic';
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    private readonly opts: { apiKey?: string; refusalFallback: boolean; logger?: Logger; timeoutMs?: number },
  ) {
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), timeout: opts.timeoutMs ?? 90_000, maxRetries: 2 });
  }

  async generateJson<T>(req: StructuredRequest<T>): Promise<T> {
    const started = Date.now();
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: req.maxTokens ?? 16000,
          ...(this.opts.refusalFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.schema } },
        },
        { signal: req.signal },
      );
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError) throw new LlmError(`Requisição inválida ao modelo (${req.purpose})`, false);
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
        throw new LlmError('Credenciais do provedor de IA inválidas', false);
      if (err instanceof Anthropic.RateLimitError) throw new LlmError('Limite de requisições do provedor de IA', true);
      if (err instanceof Anthropic.APIError) throw new LlmError(`Erro do provedor de IA (HTTP ${err.status})`, true);
      if (err instanceof Anthropic.APIConnectionError) throw new LlmError('Falha de conexão com o provedor de IA', true);
      throw err;
    }

    this.opts.logger?.debug(
      { purpose: req.purpose, ms: Date.now() - started, in: response.usage.input_tokens, out: response.usage.output_tokens, stop: response.stop_reason },
      'llm_call',
    );
    if (response.stop_reason === 'refusal') throw new LlmError('O modelo recusou a solicitação', false);
    if (response.stop_reason === 'max_tokens') throw new LlmError('Resposta do modelo truncada', true);

    const text = response.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text;
    if (!text) throw new LlmError('Resposta do modelo sem conteúdo', true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LlmError('Resposta do modelo não é JSON válido', true);
    }
    const result = req.validator.safeParse(parsed);
    if (!result.success) throw new LlmError('Resposta do modelo fora do contrato', true);
    return result.data;
  }
}

/** Helpers para JSON Schema estrito exigido por saídas estruturadas. */
export const js = {
  str: (description?: string) => ({ type: 'string', ...(description ? { description } : {}) }),
  num: () => ({ type: 'number' }),
  bool: () => ({ type: 'boolean' }),
  enumOf: (values: readonly string[]) => ({ type: 'string', enum: [...values] }),
  arr: (items: Record<string, unknown>) => ({ type: 'array', items }),
  obj: (properties: Record<string, Record<string, unknown>>) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }),
};
