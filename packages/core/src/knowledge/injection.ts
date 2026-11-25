import { stripAccents } from './text';

/**
 * Detector heurístico de prompt injection em conteúdo de documentos.
 * Não bloqueia a indexação (o documento pode ser legítimo), mas marca o trecho como suspeito:
 * ele é sinalizado na UI/admin e enviado ao modelo com aviso adicional. A defesa principal é estrutural:
 * documentos são dados, permissões vivem em código, e o modelo não tem ferramentas com efeitos colaterais.
 */
const PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'ignore_instructions', re: /\b(ignore|ignorar|ignore[ -]se|desconsidere|desconsiderar|esqueca|esquecer|disregard|forget)\b[^.\n]{0,40}\b(instruc|regras|orientac|instructions?|rules|prompts?|above|anteriores|previous)/i },
  { label: 'role_override', re: /\b(you are now|from now on you|voce agora e|a partir de agora voce|aja como|act as|finja ser|pretend to be)\b/i },
  { label: 'system_prompt', re: /\b(system prompt|prompt do sistema|mensagem do sistema|developer message|instrucoes do sistema)\b/i },
  { label: 'fake_tags', re: /<\/?\s*(system|assistant|instructions?|tool_use|admin)\s*>/i },
  { label: 'exfiltration', re: /\b(revele|revelar|mostre|exiba|reveal|print|output|envie|send)\b[^.\n]{0,50}\b(senha|password|segredo|secret|api[ _-]?key|chave|token|credenciais|credentials)\b/i },
  { label: 'privilege', re: /\b(conceda|conceder|grant|elevate|eleve)\b[^.\n]{0,40}\b(acesso|access|permiss|privileg|admin)/i },
  { label: 'links_exfil', re: /!\[[^\]]*\]\(https?:\/\/[^)]*\{/i },
];

export interface InjectionScan {
  suspicious: boolean;
  labels: string[];
}

export function scanForInjection(text: string): InjectionScan {
  const normalized = stripAccents(text);
  const labels = PATTERNS.filter((p) => p.re.test(normalized)).map((p) => p.label);
  return { suspicious: labels.length > 0, labels };
}
