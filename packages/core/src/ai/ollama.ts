import type { Logger } from '../logging/logger';
import type { EmbeddingProvider } from './embeddings';
import { LlmError, type LlmProvider, type StructuredRequest } from './llm';

/**
 * Provedores gratuitos e locais via Ollama (https://ollama.com).
 * O modelo roda na própria máquina/servidor: sem custo por uso e sem enviar documentos a terceiros.
 * Indicado para protótipos e para ambientes que exigem que os dados não saiam da rede.
 */

async function post<T>(baseUrl: string, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new LlmError('Ollama indisponível — verifique se o serviço está rodando (ollama serve)', true);
  }
  if (res.status === 404) throw new LlmError('Modelo não encontrado no Ollama — rode "ollama pull <modelo>"', false);
  if (!res.ok) throw new LlmError(`Erro do Ollama (HTTP ${res.status})`, res.status >= 500);
  return (await res.json()) as T;
}

/** Mesmas opções em todas as chamadas: mudar num_ctx força o Ollama a recarregar o modelo. */
const OLLAMA_OPTIONS = { temperature: 0, num_ctx: 8192 };
/** Mantém o modelo na GPU entre perguntas (o padrão de 5 min causava cargas a frio de ~1 min). */
const KEEP_ALIVE = '30m';

export class OllamaLlmProvider implements LlmProvider {
  readonly id = 'ollama';

  /** Carrega o modelo na memória antes da primeira pergunta (chamada vazia, sem gerar texto). */
  async warmUp(): Promise<void> {
    await post(this.opts.baseUrl, '/api/chat', { model: this.model, messages: [], keep_alive: KEEP_ALIVE, options: OLLAMA_OPTIONS }, 180_000);
  }

  constructor(
    readonly model: string,
    private readonly opts: { baseUrl: string; logger?: Logger; timeoutMs?: number },
  ) {}

  async generateJson<T>(req: StructuredRequest<T>): Promise<T> {
    const started = Date.now();
    const out = await post<{ message?: { content?: string }; done_reason?: string; eval_count?: number; prompt_eval_count?: number }>(
      this.opts.baseUrl,
      '/api/chat',
      {
        model: this.model,
        stream: false,
        // Saída estruturada: o Ollama restringe a geração ao JSON Schema informado.
        format: req.schema,
        options: OLLAMA_OPTIONS,
        keep_alive: KEEP_ALIVE,
        messages: [
          { role: 'system', content: `${req.system}\n\nResponda somente com JSON válido no formato solicitado.` },
          { role: 'user', content: req.user },
        ],
      },
      this.opts.timeoutMs ?? 120_000,
      req.signal,
    );
    this.opts.logger?.debug({ purpose: req.purpose, ms: Date.now() - started, in: out.prompt_eval_count, out: out.eval_count }, 'llm_call');
    if (out.done_reason === 'length') throw new LlmError('Resposta do modelo truncada', true);
    const text = out.message?.content;
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

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama';

  constructor(
    readonly dim: number,
    private readonly model: string,
    private readonly baseUrl: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const res = await post<{ embeddings: number[][] }>(this.baseUrl, '/api/embed', { model: this.model, input: texts.slice(i, i + 32), keep_alive: KEEP_ALIVE }, 120_000).catch((err: Error) => {
        throw new Error(`Embeddings via Ollama falharam: ${err.message}`);
      });
      for (const v of res.embeddings) {
        if (v.length !== this.dim) throw new Error(`O modelo ${this.model} gera vetores de ${v.length} dimensões; ajuste EMBEDDING_DIM=${v.length} e reindexe`);
        out.push(v);
      }
    }
    return out;
  }
}
