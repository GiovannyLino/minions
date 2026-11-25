import { MemoryStorageProvider, createDb, createLogger, createMinions, loadEnv, type LlmProvider, type Minions } from '@minions/core';
import { createApp } from '../src/app';
import { seed } from '../src/seed';

export const TEST_ENV = {
  NODE_ENV: 'test',
  AUTH_MODE: 'dev',
  AUTH_SECRET: 'test-secret-'.padEnd(48, 'x'),
  LLM_PROVIDER: 'none',
  EMBEDDING_PROVIDER: 'hash',
  EMBEDDING_DIM: '256',
  RATE_LIMIT_PER_MINUTE: '600',
  DATA_DIR: '.data-test',
};

export async function createTestSystem(opts: { llm?: LlmProvider | null; env?: Record<string, string> } = {}) {
  const env = loadEnv({ ...TEST_ENV, ...opts.env });
  const minions: Minions = await createMinions(env, {
    db: await createDb({ dataDir: 'memory://' }),
    storage: new MemoryStorageProvider(),
    logger: createLogger({ level: 'silent' }),
    llm: opts.llm ?? null,
  });
  const fixtures = await seed(minions);
  const app = createApp(minions, { trustProxy: false });
  const tokens: Record<string, string> = {};
  for (const [key, user] of env.AUTH_MODE === 'dev' ? fixtures.users : []) {
    const res = await app.request('/v1/auth/dev-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: user.id }) });
    tokens[key] = ((await res.json()) as { token: string }).token;
  }
  const api = (who: keyof typeof tokens | null, path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  return { minions, app, fixtures, tokens, api };
}

/** Lê um stream SSE do endpoint /v1/chat e devolve os eventos. */
export async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return event && data ? { event, data: JSON.parse(data) } : null;
    })
    .filter((x): x is { event: string; data: any } => x !== null);
}

export async function ask(api: Awaited<ReturnType<typeof createTestSystem>>['api'], who: string, message: string, conversationId?: string) {
  const res = await api(who, '/v1/chat', { method: 'POST', body: JSON.stringify({ message, conversationId }) });
  const events = await readSse(res);
  const answer = events.find((e) => e.event === 'answer')?.data;
  const conversation = events.find((e) => e.event === 'conversation')?.data;
  return { res, events, answer: answer?.answer, messageId: answer?.messageId, conversationId: conversation?.id as string };
}
