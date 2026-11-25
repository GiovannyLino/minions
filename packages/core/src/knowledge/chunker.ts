import type { ExtractedSection } from './extractors';
import { estimateTokens, splitSentences } from './text';

export interface Chunk {
  ordinal: number;
  content: string;
  page: number | null;
  section: string | null;
  tokenEstimate: number;
}

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
  minChars?: number;
}

/**
 * Divide seções em trechos de ~900 caracteres respeitando parágrafos e frases, com sobreposição
 * para não perder contexto entre trechos. Nunca mistura páginas/seções diferentes num mesmo trecho,
 * garantindo citações precisas.
 */
export function chunkSections(sections: ExtractedSection[], opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 900;
  const overlap = opts.overlapChars ?? 150;
  const minChars = opts.minChars ?? 40;
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const units = section.text
      .split(/\n{2,}|\n(?=[•\-*\d]+[.)]?\s)/)
      .flatMap((p) => (p.length > maxChars ? splitSentences(p).flatMap((s) => hardSplit(s, maxChars)) : [p]))
      .map((u) => u.trim())
      .filter(Boolean);

    let current = '';
    const push = () => {
      const content = current.trim();
      if (content.length >= minChars || (content.length > 0 && chunks.length === 0)) {
        chunks.push({ ordinal: chunks.length, content, page: section.page, section: section.section, tokenEstimate: estimateTokens(content) });
      } else if (content.length > 0 && chunks.length > 0) {
        const last = chunks[chunks.length - 1]!;
        if (last.page === section.page && last.section === section.section) {
          last.content = `${last.content}\n${content}`;
          last.tokenEstimate = estimateTokens(last.content);
        } else {
          chunks.push({ ordinal: chunks.length, content, page: section.page, section: section.section, tokenEstimate: estimateTokens(content) });
        }
      }
    };

    for (const unit of units) {
      if (current && current.length + unit.length + 1 > maxChars) {
        push();
        current = tail(current, overlap);
      }
      current = current ? `${current}\n${unit}` : unit;
    }
    push();
  }
  return chunks.map((c, i) => ({ ...c, ordinal: i }));
}

function hardSplit(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

/** Final do trecho anterior começando em fronteira de palavra (sobreposição). */
function tail(s: string, n: number): string {
  if (n <= 0 || s.length <= n) return '';
  const cut = s.slice(-n);
  const space = cut.indexOf(' ');
  return space >= 0 ? cut.slice(space + 1) : cut;
}
