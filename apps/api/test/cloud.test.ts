import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DbRateLimiter,
  DbStorageProvider,
  GeminiEmbeddingProvider,
  GeminiLlmProvider,
  createDb,
  createLogger,
  createMinions,
  devLoginAllowed,
  loadEnv,
  migrate,
} from '@minions/core';
import { createApp } from '../src/app';
import { seed } from '../src/seed';
import { drainJobs } from '../src/maintenance';
import { TEST_ENV, ask, createTestSystem } from './helpers';

/** Servidor que imita a API do Gemini — nenhuma chamada real ao Google. */
let server: Server;
let baseUrl: string;
const requests: { url: string; headers: Record<string, unknown>; body: any }[] = [];
let throttleOnce = false;

const SYNTHESIS = {
  sufficient: true,
  summary: 'Para abrir uma solicitação de compras, use o Portal de Suprimentos [S1].',
  steps: [],
  conflicts: [],
  suggestions: [],
  next_actions: [],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data || '{}');
      requests.push({ url: req.url!, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-goog-api-key'] !== 'chave-teste') {
        res.statusCode = 403;
        return res.end('{"error":{"code":403,"message":"API key not valid"}}');
      }
      if (req.url?.endsWith(':batchEmbedContents')) {
        const dim = body.requests[0].outputDimensionality;
        return res.end(JSON.stringify({ embeddings: body.requests.map((_: unknown, i: number) => ({ values: Array.from({ length: dim }, (_, j) => i + j + 1) })) }));
      }
      if (req.url?.includes(':generateContent')) {
        if (throttleOnce) {
          throttleOnce = false;
          res.statusCode = 429;
          return res.end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.05s' }] } }));
        }
        if (req.url.includes('sem-schema') && body.generationConfig.responseJsonSchema) {
          res.statusCode = 400;
          return res.end('{"error":{"code":400,"message":"Unknown name responseJsonSchema"}}');
        }
        const parts = [{ text: 'pensando…', thought: true }, { text: JSON.stringify(SYNTHESIS) }];
        return res.end(JSON.stringify({ candidates: [{ content: { parts }, finishReason: req.url.includes('truncado') ? 'MAX_TOKENS' : 'STOP' }] }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('Gemini (plano gratuito)', () => {
  it('responde com saída estruturada, chave só no header e trechos autorizados', async () => {
    requests.length = 0;
    const sys = await createTestSystem({ llm: new GeminiLlmProvider('gemini-3.5-flash-lite', { apiKey: 'chave-teste', baseUrl }) });
    try {
      const { answer } = await ask(sys.api, 'collaborator', 'Como abrir uma solicitação de compras?');
      expect(answer.mode).toBe('llm');
      expect(answer.summary).toContain('Portal de Suprimentos');
      const call = requests.find((r) => r.url.includes(':generateContent'))!;
      expect(call.url).not.toContain('chave-teste');
      expect(call.url).toContain('/models/gemini-3.5-flash-lite:generateContent');
      expect(call.body.generationConfig).toMatchObject({ temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } });
      expect(call.body.generationConfig.responseJsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(call.body.contents[0].parts[0].text).toMatch(/<document ref="S1"/);
    } finally {
      await sys.minions.close();
    }
  });

  it('respeita o atraso do limite gratuito (429) e tenta de novo', async () => {
    throttleOnce = true;
    const sys = await createTestSystem({ llm: new GeminiLlmProvider('gemini-3.5-flash-lite', { apiKey: 'chave-teste', baseUrl }) });
    try {
      const { answer } = await ask(sys.api, 'collaborator', 'Como abrir uma solicitação de compras?');
      expect(answer.mode).toBe('llm');
    } finally {
      await sys.minions.close();
    }
  });

  it('manda o esquema no prompt se o modelo recusar responseJsonSchema', async () => {
    requests.length = 0;
    const llm = new GeminiLlmProvider('modelo-sem-schema', { apiKey: 'chave-teste', baseUrl });
    const sys = await createTestSystem({ llm });
    try {
      const { answer } = await ask(sys.api, 'collaborator', 'Como abrir uma solicitação de compras?');
      expect(answer.mode).toBe('llm');
      const last = requests.filter((r) => r.url.includes(':generateContent')).at(-1)!;
      expect(last.body.generationConfig.responseJsonSchema).toBeUndefined();
      expect(last.body.systemInstruction.parts[0].text).toContain('JSON Schema');
    } finally {
      await sys.minions.close();
    }
  });

  it('cai para o modo extrativo com chave inválida ou resposta truncada', async () => {
    for (const llm of [
      new GeminiLlmProvider('gemini-3.5-flash-lite', { apiKey: 'errada', baseUrl }),
      new GeminiLlmProvider('modelo-truncado', { apiKey: 'chave-teste', baseUrl }),
    ]) {
      const sys = await createTestSystem({ llm });
      try {
        const { answer } = await ask(sys.api, 'collaborator', 'Como abrir uma solicitação de compras?');
        expect(answer.mode).toBe('extractive');
      } finally {
        await sys.minions.close();
      }
    }
  });

  it('gera embeddings normalizados com taskType e valida a dimensão', async () => {
    requests.length = 0;
    const emb = new GeminiEmbeddingProvider(8, { apiKey: 'chave-teste', baseUrl });
    const [v] = await emb.embed(['olá'], 'query');
    expect(Math.hypot(...v!)).toBeCloseTo(1, 6);
    const call = requests.at(-1)!;
    expect(call.url).toContain('/models/gemini-embedding-001:batchEmbedContents');
    expect(call.body.requests[0]).toMatchObject({ model: 'models/gemini-embedding-001', taskType: 'RETRIEVAL_QUERY', outputDimensionality: 8 });

    const v2 = new GeminiEmbeddingProvider(8, { apiKey: 'chave-teste', baseUrl, model: 'gemini-embedding-2' });
    await v2.embed(['texto'], 'document');
    expect(requests.at(-1)!.body.requests[0].taskType).toBeUndefined();
    expect(requests.at(-1)!.body.requests[0].content.parts[0].text).toMatch(/^title: none \| text: /);
  });
});

describe('regras de ambiente para a nuvem', () => {
  const base = { ...TEST_ENV, NODE_ENV: 'production', AUTH_MODE: 'dev', EMBEDDING_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', EMBEDDING_DIM: '768' };

  it('demonstração em produção exige código de acesso forte e dados fictícios', () => {
    expect(() => loadEnv(base)).toThrow(/DEMO_ACCESS_CODE/);
    expect(() => loadEnv({ ...base, DEMO_ACCESS_CODE: 'curto' })).toThrow(/12 caracteres/);
    const env = loadEnv({ ...base, DEMO_ACCESS_CODE: 'codigo-bem-longo-123' });
    expect(devLoginAllowed(env)).toBe(true);
    expect(() => loadEnv({ ...base, DEMO_ACCESS_CODE: 'codigo-bem-longo-123', ALLOW_REAL_DATA: 'true' })).toThrow(/AUTH_MODE/);
    expect(devLoginAllowed(loadEnv({ ...TEST_ENV, AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://x', OIDC_AUDIENCE: 'a', OIDC_JWKS_URI: 'https://x/k' }))).toBe(false);
  });

  it('Gemini gratuito não aceita dados reais', () => {
    const real = { ...TEST_ENV, LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', ALLOW_REAL_DATA: 'true' };
    expect(() => loadEnv(real)).toThrow(/GEMINI_PAID_TIER/);
    expect(() => loadEnv({ ...real, GEMINI_PAID_TIER: 'true' })).not.toThrow();
    expect(() => loadEnv({ ...TEST_ENV, LLM_PROVIDER: 'gemini' })).toThrow(/GEMINI_API_KEY/);
  });

  it('na Vercel exige Postgres, arquivos no banco e upload de até 4 MB', () => {
    const vercel = { ...base, DEMO_ACCESS_CODE: 'codigo-bem-longo-123', VERCEL: '1' };
    expect(() => loadEnv(vercel)).toThrow(/DATABASE_URL[\s\S]*STORAGE_PROVIDER/);
    expect(() => loadEnv({ ...vercel, DATABASE_URL: 'postgres://x', STORAGE_PROVIDER: 'db', LLM_PROVIDER: 'ollama' })).toThrow(/Ollama/);
    const ok = loadEnv({ ...vercel, DATABASE_URL: 'postgres://x', STORAGE_PROVIDER: 'db', MAX_UPLOAD_MB: '25' });
    expect(ok.MAX_UPLOAD_MB).toBe(4);
  });
});

describe('peças serverless', () => {
  it('migrações são idempotentes e criam as tabelas novas', async () => {
    const db = await createDb({ dataDir: 'memory://' });
    try {
      expect(await migrate(db, { embeddingDim: 64 })).toEqual(['001_init.sql', '002_answer_memory.sql', '003_serverless.sql']);
      expect(await migrate(db, { embeddingDim: 64 })).toEqual([]);
      expect(await db.one<{ ok: boolean }>(`select to_regclass('file_blobs') is not null and to_regclass('rate_limits') is not null as ok`)).toEqual({ ok: true });
    } finally {
      await db.close();
    }
  });

  it('limite de requisições no banco vale entre instâncias e libera após a janela', async () => {
    const db = await createDb({ dataDir: 'memory://' });
    try {
      await migrate(db, { embeddingDim: 64 });
      const a = new DbRateLimiter(db, 2, 60);
      const b = new DbRateLimiter(db, 2, 60); // "outra instância"
      expect(await a.take('k')).toEqual({ ok: true });
      expect(await b.take('k')).toEqual({ ok: true });
      const blocked = await a.take('k');
      expect(blocked.ok).toBe(false);
      expect(!blocked.ok && blocked.retryAfter).toBeGreaterThan(0);
      expect((await b.take('k', 0)).ok).toBe(false); // consulta sem consumir
      await db.query(`update rate_limits set window_start = now() - interval '2 minutes'`);
      expect(await a.take('k')).toEqual({ ok: true });
    } finally {
      await db.close();
    }
  });

  it('upload, indexação e download com arquivos guardados no banco', async () => {
    const env = loadEnv({ ...TEST_ENV, STORAGE_PROVIDER: 'db' });
    const db = await createDb({ dataDir: 'memory://' });
    const minions = await createMinions(env, { db, logger: createLogger({ level: 'silent' }), llm: null });
    try {
      const fixtures = await seed(minions);
      const app = createApp(minions, { trustProxy: false });
      const login = await app.request('/v1/auth/dev-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: fixtures.users.get('manager')!.id }) });
      const { token } = (await login.json()) as { token: string };
      const auth = { authorization: `Bearer ${token}` };
      const form = new FormData();
      form.set('file', new File(['# Procedimento Ômega\n\nO código OMEGA-12 identifica o fluxo.'], 'omega.md'));
      form.set('metadata', JSON.stringify({ title: 'Procedimento Ômega', category: 'Procedimento', area: 'Comercial' }));
      const up = await app.request('/v1/documents', { method: 'POST', headers: auth, body: form });
      expect(up.status).toBe(201);
      const doc = (await up.json()) as { id: string };
      expect(await drainJobs(minions, { budgetMs: 20_000 })).toBeGreaterThan(0);
      expect(((await (await app.request(`/v1/documents/${doc.id}`, { headers: auth })).json()) as { status: string }).status).toBe('ready');
      const blobs = await db.query<{ n: number }>('select count(*)::int as n from file_blobs');
      expect(blobs[0]!.n).toBeGreaterThan(0);
      const link = (await (await app.request(`/v1/documents/${doc.id}/download-link`, { method: 'POST', headers: auth })).json()) as { url: string };
      const file = await app.request(link.url.replace('/api', ''), { headers: auth });
      expect(await file.text()).toContain('OMEGA-12');
    } finally {
      await minions.close();
    }
  });
});
