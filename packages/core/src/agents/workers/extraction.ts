import type { Evidence } from '../../knowledge/search';
import { anchorTerms, termCoverage } from '../../knowledge/search';
import { scanForInjection } from '../../knowledge/injection';
import { splitSentences, truncate } from '../../knowledge/text';
import type { ExtractedStep } from '../types';

const DEFINITION_HINT = /\b(é|são|significa|refere-se|consiste|corresponde|trata-se|serve para|tem como objetivo|é utilizad[oa]|é o|é a)\b/i;

/**
 * Seleciona frases dos trechos que respondem à pergunta, priorizando definições e frases com os termos-âncora.
 * As frases são copiadas literalmente — nada é inventado.
 */
export function extractFindings(question: string, evidence: Evidence[], max = 4): { text: string; chunkId: string }[] {
  const anchors = anchorTerms(question);
  const scored: { text: string; chunkId: string; score: number }[] = [];
  for (const e of evidence) {
    // Linhas de lista (•, -) viram frases; etapas numeradas ficam para o extrator de passos.
    const lines = e.content
      .split('\n')
      .filter((l) => !/^\s*\d{1,2}\s*[.)]/.test(l) && !/^\s*>/.test(l))
      .map((l) => l.replace(/^\s*[•\-*]\s+/, ''));
    const sentences = lines.flatMap((l) => splitSentences(l));
    sentences.forEach((s, idx) => {
      // Frases com padrão de prompt injection nunca são repassadas ao usuário como "resposta".
      if (s.length < 25 || scanForInjection(s).suspicious) return;
      const cov = termCoverage(anchors, s);
      if (cov === 0) return;
      const def = DEFINITION_HINT.test(s) ? 0.5 : 0;
      // Trechos sinalizados como suspeitos (possível prompt injection) são despriorizados.
      const penalty = e.suspicious ? 0.6 : 0;
      scored.push({ text: truncate(s, 320), chunkId: e.chunkId, score: cov + def + e.relevance * 0.5 - idx * 0.02 - penalty });
    });
  }
  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((s) => {
      const k = s.text.slice(0, 60);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, max)
    .map(({ text, chunkId }) => ({ text, chunkId }));
}

const STEP_LINE = /^\s*(?:(?:passo|etapa)\s*(\d+)\s*[:.\-–—]?|(\d{1,2})\s*[.)\-–—]|[•\-*])\s+(.+)$/i;

/** Extrai passos numerados/marcados dos trechos de procedimento, preservando a ordem do documento. */
export function extractSteps(evidence: Evidence[], max = 10): ExtractedStep[] {
  const byDoc = new Map<string, Evidence[]>();
  for (const e of evidence) byDoc.set(e.documentId, [...(byDoc.get(e.documentId) ?? []), e]);
  // Usa o documento mais relevante que contenha passos.
  const docs = [...byDoc.values()].sort((a, b) => Math.max(...b.map((x) => x.relevance)) - Math.max(...a.map((x) => x.relevance)));
  for (const chunks of docs) {
    const ordered = [...chunks].sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || a.chunkId.localeCompare(b.chunkId));
    const steps: ExtractedStep[] = [];
    const seen = new Set<string>();
    for (const c of ordered) {
      for (const line of c.content.split('\n')) {
        const m = STEP_LINE.exec(line);
        if (!m) continue;
        const body = m[3]!.trim();
        if (body.length < 8 || seen.has(body) || scanForInjection(body).suspicious) continue;
        seen.add(body);
        const [head, ...rest] = body.split(/:\s+|\s+[—–-]\s+/);
        const title = rest.length && head!.length <= 80 ? head! : truncate(body, 80);
        const detail = rest.length && head!.length <= 80 ? rest.join(': ') : body;
        const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
        steps.push({ title: cap(title.replace(/[.;]$/, '')), detail: cap(truncate(detail, 400)), chunkIds: [c.chunkId] });
      }
    }
    if (steps.length >= 2) return steps.slice(0, max);
  }
  return [];
}
