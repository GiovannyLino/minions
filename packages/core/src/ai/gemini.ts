import type { Logger } from '../logging/logger';
import type { EmbeddingProvider } from './embeddings';
import { LlmError, type LlmProvider, type StructuredRequest } from './llm';

/**
 * Google Gemini (API do Google AI Studio) — tem plano gratuito, sem cartão.
 *
 * ATENÇÃO (LGPD): no plano gratuito o Google pode usar o conteúdo enviado para melhorar os
 * produtos dele. Por isso o ambiente recusa ALLOW_REAL_DATA=true com Gemini, a menos que
 * GEMINI_PAID_TIER=true (projeto com faturamento ativo, em que o conteúdo não é usado).
 *
 * - A chave vai só no header `x-goog-api-key` (nunca na URL, que pode aparecer em logs).
 * - Apenas os trechos já autorizados pela ACL (filtrada no SQL) são enviados ao modelo.
 */

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: { '@type'?: string; retryDelay?: string }[] };
}

/** Lê o atraso sugerido pelo Google em respostas 429 (ex.: "12s"). */
function retryDelayMs(body: GeminiErrorBody | null): number | null {
  const raw = body?.error?.details?.find((d) => d.retryDelay)?.retryDelay;
  const secs = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(secs) ? Math.ceil(secs * 1000) : null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new LlmError('Operação cancelada', false));
    });
  });

export class GeminiHttpError extends LlmError {
  constructor(
    message: string,
    retryable: boolean,
    public readonly status: number,
  ) {
    super(message, retryable);
    this.name = 'GeminiHttpError';
  }
}

interface CallOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** Tentativas extras em 429/5xx, respeitando o atraso sugerido (limitado por maxWaitMs). */
  retries: number;
  maxWaitMs: number;
  signal?: AbortSignal;
}

async function callGemini<T>(path: string, body: unknown, opts: CallOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify(body),
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
    } catch {
      if (opts.signal?.aborted) throw new LlmError('Operação cancelada', false);
      if (attempt < opts.retries) continue;
      throw new LlmError('Falha de conexão com o Gemini', true);
    }
    if (res.ok) return (await res.json()) as T;

    const errBody = (await res.json().catch(() => null)) as GeminiErrorBody | null;
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < opts.retries) {
      const wait = Math.min(opts.maxWaitMs, retryDelayMs(errBody) ?? 1500 * 2 ** attempt);
      await sleep(wait, opts.signal);
      continue;
    }
    if (res.status === 400) throw new GeminiHttpError(`Requisição recusada pelo Gemini: ${errBody?.error?.message?.slice(0, 200) ?? 'HTTP 400'}`, false, 400);
    if (res.status === 401 || res.status === 403) throw new GeminiHttpError('Chave do Gemini inválida ou sem permissão (GEMINI_API_KEY)', false, res.status);
    if (res.status === 404) throw new GeminiHttpError('Modelo do Gemini não encontrado — confira GEMINI_MODEL / EMBEDDING_MODEL', false, 404);
    if (res.status === 429) throw new GeminiHttpError('Limite gratuito do Gemini atingido no momento — tente novamente em instantes', true, 429);
    throw new GeminiHttpError(`Erro do Gemini (HTTP ${res.status})`, retryable, res.status);
  }
}

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GeminiLlmProvider implements LlmProvider {
  readonly id = 'gemini';
  /** Desligado se o modelo recusar `responseJsonSchema`/`thinkingConfig` (o esquema passa a ir no prompt). */
  private nativeSchema = true;

  constructor(
    readonly model: string,
    private readonly opts: { apiKey: string; baseUrl?: string; logger?: Logger; timeoutMs?: number },
  ) {}

  private thinkingConfig(effort: StructuredRequest<unknown>['effort']): Record<string, unknown> | undefined {
    // Gemini 3+ aceita thinkingLevel; respostas rápidas importam mais que raciocínio longo aqui.
    if (!/^gemini-([3-9]|\d{2,})/.test(this.model)) return undefined;
    return { thinkingLevel: effort === 'high' ? 'high' : 'low' };
  }

  async generateJson<T>(req: StructuredRequest<T>): Promise<T> {
    const started = Date.now();
    const call = (native: boolean) =>
      callGemini<GenerateResponse>(
        `/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          systemInstruction: {
            parts: [
              {
                text: native
                  ? `${req.system}\n\nResponda somente com JSON válido no formato solicitado.`
                  : `${req.system}\n\nResponda somente com JSON válido que siga exatamente este JSON Schema:\n${JSON.stringify(req.schema)}`,
              },
            ],
          },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: req.maxTokens ?? 8192,
            responseMimeType: 'application/json',
            ...(native ? { responseJsonSchema: req.schema } : {}),
            ...(native && this.thinkingConfig(req.effort) ? { thinkingConfig: this.thinkingConfig(req.effort) } : {}),
          },
        },
        { apiKey: this.opts.apiKey, baseUrl: this.opts.baseUrl ?? DEFAULT_BASE_URL, timeoutMs: this.opts.timeoutMs ?? 60_000, retries: 1, maxWaitMs: 8_000, signal: req.signal },
      );

    let out: GenerateResponse;
    try {
      out = await call(this.nativeSchema);
    } catch (err) {
      if (!(err instanceof GeminiHttpError && err.status === 400 && this.nativeSchema)) throw err;
      this.opts.logger?.warn({ model: this.model }, 'gemini_native_schema_unsupported');
      this.nativeSchema = false;
      out = await call(false);
    }

    this.opts.logger?.debug(
      { purpose: req.purpose, ms: Date.now() - started, in: out.usageMetadata?.promptTokenCount, out: out.usageMetadata?.candidatesTokenCount },
      'llm_call',
    );
    if (out.promptFeedback?.blockReason) throw new LlmError('O modelo recusou a solicitação', false);
    const candidate = out.candidates?.[0];
    const finish = candidate?.finishReason;
    if (finish === 'MAX_TOKENS') throw new LlmError('Resposta do modelo truncada', true);
    if (finish && finish !== 'STOP') throw new LlmError('O modelo recusou a solicitação', false);
    const text = candidate?.content?.parts?.filter((p) => !p.thought && p.text).map((p) => p.text).join('');
    if (!text) throw new LlmError('Resposta do modelo sem conteúdo', true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      throw new LlmError('Resposta do modelo não é JSON válido', true);
    }
    const result = req.validator.safeParse(parsed);
    if (!result.success) throw new LlmError('Resposta do modelo fora do contrato', true);
    return result.data;
  }
}

/**
 * Embeddings do Gemini (`gemini-embedding-001` por padrão, gratuito no plano free).
 * Dimensões menores que 3072 (ex.: 768) são normalizadas aqui, como recomenda o Google.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'gemini';

  constructor(
    readonly dim: number,
    private readonly opts: { apiKey: string; model?: string; baseUrl?: string; batchSize?: number },
  ) {}

  private get model() {
    return this.opts.model ?? 'gemini-embedding-001';
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    // A família gemini-embedding-2 não aceita taskType: a tarefa vai como prefixo do texto.
    const prefixed = /^gemini-embedding-[2-9]/.test(this.model);
    const out: number[][] = [];
    const size = Math.min(100, this.opts.batchSize ?? 50);
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size);
      const res = await callGemini<{ embeddings?: { values?: number[] }[] }>(
        `/models/${encodeURIComponent(this.model)}:batchEmbedContents`,
        {
          requests: batch.map((text) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text: prefixed ? (kind === 'query' ? `task: search result | query: ${text}` : `title: none | text: ${text}`) : text }] },
            ...(prefixed ? {} : { taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT' }),
            outputDimensionality: this.dim,
          })),
        },
        { apiKey: this.opts.apiKey, baseUrl: this.opts.baseUrl ?? DEFAULT_BASE_URL, timeoutMs: 30_000, retries: 3, maxWaitMs: 20_000 },
      ).catch((err: Error) => {
        throw new Error(`Embeddings via Gemini falharam: ${err.message}`);
      });
      const vectors = res.embeddings ?? [];
      if (vectors.length !== batch.length) throw new Error('Embeddings via Gemini: resposta incompleta');
      for (const v of vectors) {
        const values = v.values ?? [];
        if (values.length !== this.dim) throw new Error(`O modelo ${this.model} devolveu ${values.length} dimensões; ajuste EMBEDDING_DIM=${values.length} e reindexe`);
        const norm = Math.sqrt(values.reduce((s, x) => s + x * x, 0)) || 1;
        out.push(values.map((x) => x / norm));
      }
    }
    return out;
  }
}
