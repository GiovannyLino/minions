import type { Intent } from '../contracts';
import { stripAccents, tokenize } from '../knowledge/text';
import type { WorkerAgentId } from './types';

const RULES: { intent: Intent; re: RegExp }[] = [
  { intent: 'people', re: /\b(com quem|quem (e|eh|pode|sabe|cuida|responde|aprova)|responsave(l|is)|especialista|contato|falar com|tirar duvidas?|a quem)\b/ },
  { intent: 'proposal', re: /\b(propostas?|projetos?|escopo|entregave(l|is)|licitac\w*|prp-\d{2,4})/ },
  { intent: 'procedure', re: /\b(como (faco|faz|fazer|devo|posso|abrir|abro|preencher|preencho|solicitar|solicito|usar|uso|cadastrar|registrar|enviar|aprovar)|passo a passo|preencher|preenchimento|abrir|solicitar|procedimento|etapas|instruc)/ },
  { intent: 'concept', re: /\b(o que (e|eh|significa|quer dizer)|para que serve|definicao|significa|significado|conceito|sigla|explique|explica)\b/ },
  { intent: 'document_lookup', re: /\b(onde (esta|fica|encontro|acho)|qual (e )?(o )?modelo|modelo de|template|planilha|formulario|documento|arquivo|manual)\b/ },
];

/** Prioridade quando há várias intenções: a mais específica vira a principal. */
const PRIORITY: Intent[] = ['proposal', 'procedure', 'people', 'concept', 'document_lookup', 'general'];

export interface IntentPlan {
  intent: Intent;
  intents: Intent[];
  agents: WorkerAgentId[];
  confident: boolean;
}

/** Classificador por regras (rápido, sem custo). Usado sempre; o LLM só é consultado quando ele não é conclusivo. */
export function classifyIntent(question: string): IntentPlan {
  const q = stripAccents(question.toLowerCase());
  const intents = RULES.filter((r) => r.re.test(q)).map((r) => r.intent);
  const unique = [...new Set(intents)];
  const intent = PRIORITY.find((i) => unique.includes(i)) ?? 'general';
  return { intent, intents: unique.length ? unique : ['general'], agents: agentsFor(unique.length ? unique : ['general']), confident: unique.length > 0 };
}

export function agentsFor(intents: Intent[]): WorkerAgentId[] {
  const set = new Set<WorkerAgentId>();
  for (const i of intents) {
    if (i === 'concept' || i === 'general' || i === 'document_lookup') set.add('knowledge');
    if (i === 'procedure' || i === 'document_lookup') set.add('process');
    // Propostas: cadastro estruturado (Proposal) + documentos relacionados (Knowledge).
    if (i === 'proposal') set.add('proposal').add('knowledge');
    if (i === 'people') set.add('people');
  }
  // Perguntas sobre pessoas também precisam do contexto do tema (para inferir a área responsável).
  if (set.has('people') && set.size === 1) set.add('knowledge');
  return [...set];
}

const FOLLOW_UP = /\b(isso|isto|esse|essa|esses|essas|ele|ela|dele|dela|nele|nela|mesmo|mesma|aquilo|e (o|a) (responsavel|prazo|status|escopo)|e quem)\b/;

/** Perguntas de acompanhamento curtas herdam o assunto da pergunta anterior. */
export function contextualQuery(question: string, history: string[]): string {
  const previous = history[history.length - 1];
  if (!previous) return question;
  // Até 2 termos de conteúdo ("e o prazo?") = acompanhamento; perguntas com assunto próprio não herdam contexto.
  const short = tokenize(question).length <= 2;
  const anaphora = FOLLOW_UP.test(stripAccents(question.toLowerCase()));
  return short || anaphora ? `${previous} ${question}` : question;
}
