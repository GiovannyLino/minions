import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const intDefault = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : Number.parseInt(v, 10)))
    .pipe(z.number().int().nonnegative());

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ALLOW_REAL_DATA: bool,
    API_PORT: intDefault(4000),
    WEB_ORIGIN: z.string().default('http://localhost:3000'),
    DATABASE_URL: optionalString,
    DATA_DIR: z.string().default('.data'),
    /** Conexões por instância. Em serverless (Vercel) use poucas e a URL "pooled" do Neon. */
    PG_POOL_MAX: intDefault(10),
    /** local = disco (DATA_DIR/storage) · db = dentro do Postgres (necessário em serverless, ex.: Vercel) */
    STORAGE_PROVIDER: z.enum(['local', 'db']).default('local'),
    /** Definido automaticamente pela Vercel ("1"). */
    VERCEL: optionalString,
    /** Código do portão da demonstração pública. Obrigatório para usar AUTH_MODE=dev em produção. */
    DEMO_ACCESS_CODE: optionalString,
    EMBEDDED_WORKER: z
      .string()
      .optional()
      .transform((v) => v !== 'false'),

    AUTH_MODE: z.enum(['dev', 'oidc']).default('dev'),
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET precisa de pelo menos 32 caracteres'),
    OIDC_ISSUER: optionalString,
    OIDC_AUDIENCE: optionalString,
    OIDC_JWKS_URI: optionalString,
    OIDC_GROUPS_CLAIM: z.string().default('groups'),
    OIDC_ROLES_CLAIM: z.string().default('roles'),
    /** Escopo delegado exigido no access token (claim `scp`). Impede o uso de ID tokens como access token. */
    OIDC_REQUIRED_SCOPE: z.string().default('access_as_user'),
    /** JSON { "<objectId do grupo no Entra>": "comercial", ... } — grupos não mapeados são ignorados. */
    OIDC_GROUP_MAP: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (!v || !v.trim()) return {} as Record<string, string>;
        try {
          const parsed = JSON.parse(v) as unknown;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
          return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, g]) => [k.toLowerCase(), String(g).toLowerCase()]));
        } catch {
          ctx.addIssue({ code: 'custom', message: 'OIDC_GROUP_MAP deve ser um objeto JSON' });
          return {} as Record<string, string>;
        }
      }),

    /** none = extrativo (grátis) · gemini = Google Gemini (plano gratuito) · ollama = modelo local (grátis) · anthropic = Claude (pago por uso) */
    LLM_PROVIDER: z.enum(['none', 'gemini', 'ollama', 'anthropic']).default('none'),
    GEMINI_API_KEY: optionalString,
    GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
    /** true somente se o projeto do Google tiver faturamento ativo (o conteúdo deixa de ser usado pelo Google). */
    GEMINI_PAID_TIER: bool,
    OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
    OLLAMA_MODEL: z.string().default('qwen2.5:7b'),
    ANTHROPIC_API_KEY: optionalString,
    LLM_MODEL: z.string().default('claude-opus-5-5'),
    AI_REFUSAL_FALLBACK: z.enum(['default', 'off']).default('default'),
    EMBEDDING_PROVIDER: z.enum(['hash', 'gemini', 'ollama', 'voyage', 'openai']).default('hash'),
    EMBEDDING_DIM: intDefault(384),
    EMBEDDING_MODEL: optionalString,
    EMBEDDING_API_KEY: optionalString,
    EMBEDDING_BASE_URL: optionalString,

    MAX_UPLOAD_MB: intDefault(25),
    MALWARE_SCANNER: z.enum(['none', 'clamav']).default('none'),
    CLAMAV_HOST: z.string().default('127.0.0.1'),
    CLAMAV_PORT: intDefault(3310),

    RATE_LIMIT_PER_MINUTE: intDefault(60),
    AGENT_MAX_CALLS: intDefault(8),
    AGENT_MAX_DEPTH: intDefault(2),
    AGENT_MAX_LLM_CALLS: intDefault(6),
    AGENT_TIMEOUT_MS: intDefault(60000),
    RETENTION_CONVERSATION_DAYS: intDefault(180),
    RETENTION_AUDIT_DAYS: intDefault(730),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.AUTH_MODE === 'dev') {
      // Exceção controlada: demonstração pública com dados fictícios, atrás do portão de código de acesso.
      if (!env.DEMO_ACCESS_CODE || env.ALLOW_REAL_DATA) {
        ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'AUTH_MODE=dev em produção só é permitido como demonstração: defina DEMO_ACCESS_CODE e mantenha ALLOW_REAL_DATA=false' });
      } else if (env.DEMO_ACCESS_CODE.length < 12) {
        ctx.addIssue({ code: 'custom', path: ['DEMO_ACCESS_CODE'], message: 'DEMO_ACCESS_CODE precisa de pelo menos 12 caracteres em produção' });
      }
    }
    const usesGemini = env.LLM_PROVIDER === 'gemini' || env.EMBEDDING_PROVIDER === 'gemini';
    if (env.LLM_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'GEMINI_API_KEY é obrigatório com LLM_PROVIDER=gemini (crie grátis em https://aistudio.google.com/apikey)' });
    }
    if (env.EMBEDDING_PROVIDER === 'gemini' && !env.GEMINI_API_KEY && !env.EMBEDDING_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['GEMINI_API_KEY'], message: 'GEMINI_API_KEY é obrigatório com EMBEDDING_PROVIDER=gemini' });
    }
    if (usesGemini && env.ALLOW_REAL_DATA && !env.GEMINI_PAID_TIER) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOW_REAL_DATA'],
        message: 'No plano gratuito do Gemini o Google pode usar o conteúdo enviado: dados reais exigem GEMINI_PAID_TIER=true (projeto com faturamento)',
      });
    }
    if (env.VERCEL) {
      if (!env.DATABASE_URL) ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'Na Vercel o disco é temporário: configure DATABASE_URL (Postgres com pgvector, ex.: Neon)' });
      if (env.STORAGE_PROVIDER !== 'db') ctx.addIssue({ code: 'custom', path: ['STORAGE_PROVIDER'], message: 'Na Vercel use STORAGE_PROVIDER=db (o disco da função é apagado)' });
      if (env.LLM_PROVIDER === 'ollama' || env.EMBEDDING_PROVIDER === 'ollama') {
        ctx.addIssue({ code: 'custom', path: ['LLM_PROVIDER'], message: 'A Vercel não alcança o Ollama do seu computador: use LLM_PROVIDER=gemini (ou none)' });
      }
    }
    if (env.AUTH_MODE === 'oidc' && (!env.OIDC_ISSUER || !env.OIDC_AUDIENCE || !env.OIDC_JWKS_URI)) {
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'OIDC_ISSUER, OIDC_AUDIENCE e OIDC_JWKS_URI são obrigatórios em AUTH_MODE=oidc' });
    }
    if (env.LLM_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
      // O SDK também resolve credenciais por perfil (`ant auth login`); apenas avisamos.
    }
    if ((env.EMBEDDING_PROVIDER === 'voyage' || env.EMBEDDING_PROVIDER === 'openai') && !env.EMBEDDING_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['EMBEDDING_API_KEY'], message: 'EMBEDDING_API_KEY é obrigatório para provedores externos' });
    }
    if (env.NODE_ENV === 'production' && env.EMBEDDING_PROVIDER === 'hash') {
      ctx.addIssue({ code: 'custom', path: ['EMBEDDING_PROVIDER'], message: 'Embeddings "hash" são apenas para desenvolvimento' });
    }
  })
  // A Vercel recusa corpos de requisição acima de 4,5 MB: o limite de upload acompanha.
  .transform((env) => (env.VERCEL && env.MAX_UPLOAD_MB > 4 ? { ...env, MAX_UPLOAD_MB: 4 } : env));

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  return parsed.data;
}

/**
 * Login com usuários fictícios: liberado fora de produção ou, em produção, apenas na demonstração
 * protegida por DEMO_ACCESS_CODE e sem dados reais (o esquema acima já recusa as demais combinações).
 */
export function devLoginAllowed(env: Env): boolean {
  if (env.AUTH_MODE !== 'dev') return false;
  return env.NODE_ENV !== 'production' || (Boolean(env.DEMO_ACCESS_CODE) && !env.ALLOW_REAL_DATA);
}
