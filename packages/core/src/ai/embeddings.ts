import { createHash } from 'node:crypto';
import { normalizeText, tokenize } from '../knowledge/text';

/** Gera embeddings para documentos e consultas. A dimensão é fixa por implantação (EMBEDDING_DIM). */
export interface EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

/**
 * Embeddings lexicais por *feature hashing* (unigramas + bigramas + trigramas de caracteres).
 * Apenas para desenvolvimento/testes: determinístico, sem rede, sem custo — mas NÃO é semântico.
 * Em produção use Voyage ou Azure OpenAI (o ambiente bloqueia `hash` em produção).
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'hash';
  constructor(readonly dim = 384) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): number[] {
    const v = new Float64Array(this.dim);
    const tokens = tokenize(text);
    const add = (feature: string, weight: number) => {
      const h = createHash('md5').update(feature).digest();
      const idx = h.readUInt32LE(0) % this.dim;
      const sign = (h[4]! & 1) === 0 ? 1 : -1;
      v[idx]! += sign * weight;
    };
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      add(`w:${tok}`, 1);
      if (i > 0) add(`b:${tokens[i - 1]}_${tok}`, 0.5);
      if (tok.length > 4) for (let j = 0; j <= tok.length - 3; j++) add(`c:${tok.slice(j, j + 3)}`, 0.25);
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return Array.from(v, (x) => x / norm);
  }
}

/** Voyage AI (recomendado pela Anthropic para embeddings). */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'voyage';
  constructor(
    private readonly apiKey: string,
    readonly dim: number,
    private readonly model = 'voyage-3.5',
    private readonly baseUrl = 'https://api.voyageai.com/v1',
  ) {}

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: texts.slice(i, i + 64), input_type: kind, output_dimension: this.dim }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Voyage embeddings falhou: HTTP ${res.status}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      out.push(...json.data.map((d) => d.embedding));
    }
    return out;
  }
}

/** OpenAI ou Azure OpenAI (endpoint compatível). Para Azure: EMBEDDING_BASE_URL=https://<recurso>.openai.azure.com/openai/v1 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  constructor(
    private readonly apiKey: string,
    readonly dim: number,
    private readonly model = 'text-embedding-3-small',
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, 'api-key': this.apiKey },
        body: JSON.stringify({ model: this.model, input: texts.slice(i, i + 64), dimensions: this.dim }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Embeddings falhou: HTTP ${res.status}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      out.push(...json.data.map((d) => d.embedding));
    }
    return out;
  }
}

export function normalizeForEmbedding(text: string): string {
  return normalizeText(text).slice(0, 8000);
}
