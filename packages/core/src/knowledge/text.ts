/** Utilitários de texto em português usados por busca, intenção e embeddings de desenvolvimento. */

export const STOPWORDS = new Set(
  (
    'a o e é de do da dos das em no na nos nas um uma uns umas para pra por com sem sobre que qual quais quem como onde quando ' +
    'se ao aos à às ou mas mais menos muito muita meu minha meus minhas seu sua seus suas esse essa isso este esta isto aquele aquela ' +
    'eu tu ele ela nós vós eles elas me te lhe nos vos lhes preciso precisa precisamos quero queria gostaria saber sei não nao ' +
    'favor ajuda ajudar pode podem posso consigo devo deve tenho tem ter ser estar está esta são foi fazer faço faz fazê-lo ' +
    'algum alguma alguém alguem qualquer todo toda todos todas the of and to is'
  ).split(/\s+/),
);

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function normalizeText(s: string): string {
  return s.replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Tokens normalizados (minúsculas, sem acento, sem stopwords). Preserva siglas com hífen, ex.: "e-proc". */
export function tokenize(s: string): string[] {
  return stripAccents(s.toLowerCase())
    .split(/[^a-z0-9-]+/)
    .map((t) => t.replace(/^-+|-+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function keywords(s: string, max = 12): string[] {
  return [...new Set(tokenize(s))].slice(0, max);
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

export function splitSentences(s: string): string[] {
  return s
    .split(/(?<=[.!?;:])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9"“(])/)
    .map((x) => x.trim())
    .filter(Boolean);
}
