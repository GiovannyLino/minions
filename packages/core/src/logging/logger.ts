import pino from 'pino';

/**
 * Logger estruturado com redação de dados sensíveis.
 * Regra: nunca logar conteúdo de documentos, perguntas completas ou credenciais.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.apiKey',
  '*.secret',
  '*.content',
  '*.text',
  'question',
];

export type Logger = pino.Logger;

export function createLogger(opts: { level?: string; name?: string } = {}): Logger {
  return pino({
    name: opts.name ?? 'minions',
    level: opts.level ?? (process.env.NODE_ENV === 'test' ? 'silent' : process.env.LOG_LEVEL ?? 'info'),
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** Trunca textos livres antes de registrar (ex.: prévia de pergunta em debug). */
export function preview(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
