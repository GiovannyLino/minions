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
 * Fora do desenvolvimento use Gemini ou Ollama (o ambiente bloqueia `hash` em produção).
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

export function normalizeForEmbedding(text: string): string {
  return normalizeText(text).slice(0, 8000);
}
