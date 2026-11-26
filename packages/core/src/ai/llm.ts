import type { z } from 'zod';

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
