import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  ACTIONS,
  AppError,
  ChatRequestSchema,
  DocumentListFilterSchema,
  ForbiddenError,
  NotFoundError,
  UserUpdateSchema,
  ValidationError,
  DbRateLimiter,
  assertCan,
  can,
  devLoginAllowed,
  preview,
  signDevToken,
  type ChatAnswer,
  type Minions,
  type Principal,
  type RateLimiter,
} from '@minions/core';
import { TokenBucketLimiter, authenticate, clientIp, errorBody, rateLimit, type AppEnv } from './middleware';

const uuid = z.string().uuid();

export function createApp(minions: Minions, opts: { trustProxy?: boolean } = {}) {
  const { env, logger } = minions;
  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY !== 'false';
  const app = new Hono<AppEnv>();
  const ipOf = (c: Parameters<typeof clientIp>[0]) => clientIp(c, trustProxy);

  // Com Postgres (várias instâncias, ex.: Vercel) o limite fica no banco e vale para todas; com PGlite, em memória.
  const limiter = (perMinute: number): RateLimiter => (minions.db.kind === 'pg' ? new DbRateLimiter(minions.db, perMinute) : new TokenBucketLimiter(perMinute));
  const generalLimiter = limiter(env.RATE_LIMIT_PER_MINUTE * 4);
  const chatLimiter = limiter(Math.max(5, Math.floor(env.RATE_LIMIT_PER_MINUTE / 3)));
  const loginLimiter = limiter(10);

  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id')?.slice(0, 64) ?? randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    const started = Date.now();
    await next();
    logger.info({ requestId, method: c.req.method, path: c.req.routePath, status: c.res.status, ms: Date.now() - started }, 'http');
  });
  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-site', referrerPolicy: 'no-referrer', strictTransportSecurity: 'max-age=63072000; includeSubDomains' }));
  app.use('*', cors({ origin: env.WEB_ORIGIN, allowHeaders: ['authorization', 'content-type', 'x-request-id'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], maxAge: 600 }));

  app.onError((err, c) => {
    const { status, body } = errorBody(err);
    if (status >= 500) logger.error({ err, requestId: c.get('requestId') }, 'unhandled_error');
    return c.json(body, status as 400);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Rota não encontrada' } }, 404));

  app.get('/health', async (c) => {
    await minions.db.query('select 1');
    return c.json({ ok: true, ai: minions.llm ? 'llm' : 'extractive' });
  });

  // ───────────────────────── Autenticação de desenvolvimento ─────────────────────────
  // Em produção, só na demonstração com DEMO_ACCESS_CODE (o portão do web bloqueia tudo antes do código).
  const devAuthEnabled = devLoginAllowed(env);
  app.get('/v1/auth/config', (c) => c.json({ mode: env.AUTH_MODE, devLogin: devAuthEnabled, realDataAllowed: env.ALLOW_REAL_DATA }));
  app.get('/v1/auth/dev-users', async (c) => {
    if (!devAuthEnabled) throw new NotFoundError();
    const users = await minions.users.listDevUsers();
    return c.json(users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, area: u.area })));
  });
  app.post('/v1/auth/dev-login', rateLimit(loginLimiter, (c) => `login:${ipOf(c)}`), async (c) => {
    if (!devAuthEnabled) throw new NotFoundError();
    const body = z.object({ userId: uuid }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ValidationError('Usuário inválido');
    const devUsers = await minions.users.listDevUsers();
    const user = devUsers.find((u) => u.id === body.data.userId);
    if (!user) throw new ForbiddenError('Usuário não disponível para login de desenvolvimento');
    await minions.users.touchLogin(user.id);
    await minions.audit.record({ actorId: user.id, action: 'auth.dev_login', ip: ipOf(c) });
    return c.json({ token: await signDevToken(env.AUTH_SECRET, user.id), expiresIn: 8 * 3600 });
  });

  // ───────────────────────── Rotas autenticadas ─────────────────────────
  const v1 = new Hono<AppEnv>();
  v1.use('*', authenticate(minions));
  v1.use('*', rateLimit(generalLimiter, (c) => `u:${c.get('principal').id}`));

  v1.get('/me', (c) => {
    const p = c.get('principal');
    return c.json({ ...p, permissions: ACTIONS.filter((a) => can(p, a)) });
  });

  v1.get('/dashboard', async (c) =>
    c.json(
      await minions.dashboard.forUser(c.get('principal'), {
        aiMode: minions.orchestrator.mode,
        aiProvider: minions.llm ? `${minions.llm.id}:${minions.llm.model}` : null,
        offline: minions.offline,
        realDataAllowed: env.ALLOW_REAL_DATA,
      }),
    ),
  );

  // Chat
  const withDownloadLinks = async (p: Principal, answer: ChatAnswer): Promise<ChatAnswer> => ({
    ...answer,
    sources: await Promise.all(
      answer.sources.map(async (s) => {
        // A ACL é reavaliada: se o usuário perdeu acesso, o link não é emitido.
        const token = await minions.documents.createDownloadToken(p, s.documentId, s.versionId).catch(() => null);
        return { ...s, downloadUrl: token ? `/api/v1/files/${token}` : null };
      }),
    ),
  });

  v1.get('/conversations', async (c) => c.json(await minions.conversations.list(c.get('principal'))));
  v1.get('/conversations/:id/messages', async (c) => {
    const p = c.get('principal');
    const id = uuid.safeParse(c.req.param('id'));
    if (!id.success) throw new NotFoundError('Conversa não encontrada');
    const messages = await minions.conversations.messages(p, id.data);
    return c.json(await Promise.all(messages.map(async (m) => ({ ...m, answer: m.answer ? await withDownloadLinks(p, m.answer) : null }))));
  });
  v1.patch('/conversations/:id', async (c) => {
    const body = z.object({ title: z.string().trim().min(1).max(120) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new ValidationError('Título inválido');
    await minions.conversations.rename(c.get('principal'), c.req.param('id'), body.data.title);
    return c.json({ ok: true });
  });
  v1.delete('/conversations/:id', async (c) => {
    await minions.conversations.remove(c.get('principal'), c.req.param('id'));
    return c.json({ ok: true });
  });

  /** Pergunta ao Minions. Resposta em SSE: conversation → trace* → answer | error. */
  v1.post('/chat', rateLimit(chatLimiter, (c) => `chat:${c.get('principal').id}`), async (c) => {
    const p = c.get('principal');
    assertCan(p, 'chat:ask');
    const raw = (await c.req.json().catch(() => null)) as { message?: unknown; conversationId?: unknown } | null;
    const parsed = ChatRequestSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Pergunta inválida');
    const question = parsed.data.message;
    let conversationId = typeof raw?.conversationId === 'string' && uuid.safeParse(raw.conversationId).success ? raw.conversationId : null;
    let history: string[] = [];
    if (conversationId) history = await minions.conversations.recentUserTurns(p, conversationId);
    else conversationId = (await minions.conversations.create(p, question)).id;
    await minions.conversations.appendUser(p, conversationId, question);
    const convId = conversationId;

    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      await stream.writeSSE({ event: 'conversation', data: JSON.stringify({ id: convId }) });
      try {
        const { answer, trace } = await minions.orchestrator.ask({
          principal: p,
          question,
          conversationId: convId,
          history,
          signal: abort.signal,
          onEvent: (e) => void stream.writeSSE({ event: 'trace', data: JSON.stringify(e) }).catch(() => undefined),
        });
        const messageId = await minions.conversations.appendAssistant(p, convId, answer, trace);
        await minions.audit.record({
          actorId: p.id,
          action: 'chat.ask',
          targetType: 'conversation',
          targetId: convId,
          metadata: { status: answer.status, mode: answer.mode, intent: answer.intent, sources: answer.sources.map((s) => s.documentId), ms: answer.durationMs },
          ip: ipOf(c),
        });
        logger.debug({ q: preview(question), status: answer.status }, 'chat_answered');
        await stream.writeSSE({ event: 'answer', data: JSON.stringify({ messageId, answer: await withDownloadLinks(p, answer) }) });
      } catch (err) {
        logger.error({ err }, 'chat_failed');
        const { body } = errorBody(err);
        await stream.writeSSE({ event: 'error', data: JSON.stringify(body.error) });
      }
    });
  });

  // Documentos
  v1.get('/documents', async (c) => {
    const filter = DocumentListFilterSchema.safeParse(c.req.query());
    if (!filter.success) throw new ValidationError('Filtros inválidos', filter.error.flatten());
    return c.json(await minions.documents.list(c.get('principal'), filter.data));
  });
  v1.get('/documents/categories', async (c) => c.json(await minions.categories.list()));

  const uploadLimit = bodyLimit({ maxSize: (env.MAX_UPLOAD_MB + 1) * 1024 * 1024, onError: () => { throw new AppError('payload_too_large', `Arquivo excede ${env.MAX_UPLOAD_MB} MB`, 413); } });
  const readUpload = async (c: Context<AppEnv>) => {
    const form = await c.req.parseBody().catch(() => {
      throw new ValidationError('Envie o arquivo como multipart/form-data');
    });
    const file = form['file'];
    if (!(file instanceof File)) throw new ValidationError('Arquivo ausente (campo "file")');
    const metadata = typeof form['metadata'] === 'string' ? JSON.parse(form['metadata']) : undefined;
    return { fileName: file.name, data: Buffer.from(await file.arrayBuffer()), metadata };
  };
  v1.post('/documents', uploadLimit, async (c) => {
    const upload = await readUpload(c);
    const doc = await minions.documents.upload(c.get('principal'), { ...upload, ip: ipOf(c) });
    return c.json(doc, 201);
  });
  v1.get('/documents/:id', async (c) => c.json(await minions.documents.get(c.get('principal'), c.req.param('id'))));
  v1.get('/documents/:id/versions', async (c) => c.json(await minions.documents.versions(c.get('principal'), c.req.param('id'))));
  v1.post('/documents/:id/versions', uploadLimit, async (c) => {
    const upload = await readUpload(c);
    return c.json(await minions.documents.upload(c.get('principal'), { fileName: upload.fileName, data: upload.data, documentId: c.req.param('id'), ip: ipOf(c) }), 201);
  });
  v1.patch('/documents/:id', async (c) => c.json(await minions.documents.updateMetadata(c.get('principal'), c.req.param('id'), await c.req.json().catch(() => null), ipOf(c))));
  v1.post('/documents/:id/archive', async (c) => {
    await minions.documents.archive(c.get('principal'), c.req.param('id'), ipOf(c));
    return c.json({ ok: true });
  });
  v1.post('/documents/:id/restore', async (c) => c.json(await minions.documents.restore(c.get('principal'), c.req.param('id'), ipOf(c))));
  v1.delete('/documents/:id', async (c) => {
    await minions.documents.purge(c.get('principal'), c.req.param('id'), ipOf(c));
    return c.json({ ok: true });
  });
  v1.post('/documents/:id/download-link', async (c) => {
    const versionId = c.req.query('version');
    const token = await minions.documents.createDownloadToken(c.get('principal'), c.req.param('id'), versionId && uuid.safeParse(versionId).success ? versionId : undefined);
    return c.json({ url: `/api/v1/files/${token}`, expiresInSeconds: 300 });
  });
  v1.get('/files/:token', async (c) => {
    const file = await minions.documents.resolveDownload(c.get('principal'), c.req.param('token'), ipOf(c));
    return new Response(new Uint8Array(file.data), {
      headers: {
        'content-type': file.mime,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  // Propostas
  v1.get('/proposals', async (c) => c.json(await minions.proposals.list(c.get('principal'), { q: c.req.query('q'), status: c.req.query('status') })));
  v1.get('/proposals/:id', async (c) => c.json(await minions.proposals.get(c.get('principal'), c.req.param('id'))));
  v1.post('/proposals', async (c) => c.json(await minions.proposals.create(c.get('principal'), await c.req.json().catch(() => null)), 201));
  v1.put('/proposals/:id', async (c) => c.json(await minions.proposals.update(c.get('principal'), c.req.param('id'), await c.req.json().catch(() => null))));

  // Pessoas
  v1.get('/people', async (c) => c.json(await minions.people.list(c.get('principal'), c.req.query('q'), c.req.query('area'))));
  v1.get('/people/:id', async (c) => c.json(await minions.people.get(c.get('principal'), c.req.param('id'))));
  v1.post('/people', async (c) => c.json(await minions.people.create(c.get('principal'), await c.req.json().catch(() => null)), 201));
  v1.put('/people/:id', async (c) => c.json(await minions.people.update(c.get('principal'), c.req.param('id'), await c.req.json().catch(() => null))));
  v1.delete('/people/:id', async (c) => {
    await minions.people.remove(c.get('principal'), c.req.param('id'));
    return c.json({ ok: true });
  });

  // Administração
  v1.get('/admin/users', async (c) => {
    assertCan(c.get('principal'), 'admin:users');
    return c.json(await minions.users.list());
  });
  v1.patch('/admin/users/:id', async (c) => {
    const p = c.get('principal');
    assertCan(p, 'admin:users');
    const patch = UserUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!patch.success) throw new ValidationError('Dados inválidos', patch.error.flatten());
    if (c.req.param('id') === p.id && (patch.data.role && patch.data.role !== 'admin' || patch.data.active === false)) {
      throw new ForbiddenError('Você não pode remover o próprio acesso de administrador');
    }
    const user = await minions.users.update(c.req.param('id'), patch.data);
    await minions.audit.record({ actorId: p.id, action: 'user.updated', targetType: 'user', targetId: user.id, metadata: patch.data, ip: ipOf(c) });
    return c.json(user);
  });
  v1.get('/admin/audit', async (c) => {
    assertCan(c.get('principal'), 'admin:audit');
    return c.json(await minions.audit.list({ action: c.req.query('action'), limit: Number(c.req.query('limit') ?? 100), before: c.req.query('before') }));
  });
  v1.get('/admin/settings/agents', async (c) => {
    assertCan(c.get('principal'), 'admin:settings');
    return c.json(await minions.settings.agentSettings());
  });
  v1.put('/admin/settings/agents', async (c) => c.json(await minions.settings.updateAgentSettings(c.get('principal'), await c.req.json().catch(() => null))));
  v1.get('/admin/categories', async (c) => c.json(await minions.categories.list()));
  v1.post('/admin/categories', async (c) => c.json(await minions.categories.create(c.get('principal'), await c.req.json().catch(() => null)), 201));
  v1.delete('/admin/categories/:id', async (c) => {
    await minions.categories.remove(c.get('principal'), c.req.param('id'));
    return c.json({ ok: true });
  });
  v1.get('/admin/ingestion/errors', async (c) => c.json(await minions.documents.ingestionErrors(c.get('principal'))));
  v1.post('/admin/ingestion/:documentId/retry', async (c) => {
    await minions.documents.retryFailed(c.get('principal'), c.req.param('documentId'));
    return c.json({ ok: true });
  });
  v1.get('/admin/status', async (c) => {
    assertCan(c.get('principal'), 'admin:settings');
    const queue = await minions.db.query<{ status: string; n: number }>('select status, count(*)::int as n from ingestion_jobs group by status');
    return c.json({
      environment: env.NODE_ENV,
      authMode: env.AUTH_MODE,
      database: minions.db.kind,
      llm: minions.llm ? { provider: minions.llm.id, model: minions.llm.model } : null,
      embeddings: { provider: minions.embeddings.id, dim: minions.embeddings.dim },
      malwareScanner: env.MALWARE_SCANNER,
      realDataAllowed: env.ALLOW_REAL_DATA,
      offline: minions.offline,
      memory: await minions.memory.stats(),
      queue: Object.fromEntries(queue.map((q) => [q.status, q.n])),
    });
  });
  v1.delete('/admin/memory', async (c) => {
    const p = c.get('principal');
    assertCan(p, 'admin:settings');
    const removed = await minions.memory.clear();
    await minions.audit.record({ actorId: p.id, action: 'memory.cleared', metadata: { removed }, ip: ipOf(c) });
    return c.json({ removed });
  });

  app.route('/v1', v1);
  return app;
}
