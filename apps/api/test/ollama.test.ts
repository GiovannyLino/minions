import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OllamaEmbeddingProvider, OllamaLlmProvider } from '@minions/core';
import { ask, createTestSystem } from './helpers';

/** Servidor que imita a API do Ollama (/api/chat e /api/embed) — nenhum modelo real é baixado. */
let server: Server;
let baseUrl: string;
const requests: { path: string; body: any }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data || '{}');
      requests.push({ path: req.url!, body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/embed') {
        return res.end(JSON.stringify({ embeddings: body.input.map((_: string, i: number) => Array.from({ length: body.model === 'wrong-dim' ? 10 : 8 }, (_, j) => (i + j + 1) / 10)) }));
      }
      if (req.url === '/api/chat') {
        if (body.model === 'ausente') {
          res.statusCode = 404;
          return res.end('{"error":"model not found"}');
        }
        const content = JSON.stringify({
          sufficient: true,
          summary: 'Para abrir uma solicitação de compras, use o Portal de Suprimentos [S1]. Citação inventada [S77].',
          steps: [],
          conflicts: [],
          suggestions: [],
          next_actions: [],
        });
        return res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true, done_reason: 'stop' }));
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

describe('IA gratuita e local (Ollama)', () => {
  it('pede saída estruturada com JSON Schema e temperatura zero', async () => {
    const sys = await createTestSystem({ llm: new OllamaLlmProvider('qwen2.5:7b', { baseUrl }) });
    try {
      const { answer } = await ask(sys.api, 'collaborator', 'Como abrir uma solicitação de compras?');
      expect(answer.mode).toBe('llm');
      expect(answer.summary).toContain('Portal de Suprimentos');
      expect(answer.summary).not.toContain('[S77]');
      const chat = requests.find((r) => r.path === '/api/chat')!;
      expect(chat.body).toMatchObject({ model: 'qwen2.5:7b', stream: false, options: { temperature: 0 } });
      expect(chat.body.format).toMatchObject({ type: 'object', additionalProperties: false });
      expect(chat.body.messages[1].content).toMatch(/<document ref="S1"/);
    } finally {
      await sys.minions.close();
    }
  });

  it('cai para o modo extrativo se o modelo não existir', async () => {
    const sys = await createTestSystem({ llm: new OllamaLlmProvider('ausente', { baseUrl }) });
    try {
      const { answer } = await ask(sys.api, 'collaborator', 'Como abrir uma solicitação de compras?');
      expect(answer.mode).toBe('extractive');
      expect(answer.steps.length).toBeGreaterThan(0);
    } finally {
      await sys.minions.close();
    }
  });

  it('gera embeddings locais e valida a dimensão configurada', async () => {
    await expect(new OllamaEmbeddingProvider(8, 'nomic-embed-text', baseUrl).embed(['a', 'b'])).resolves.toHaveLength(2);
    await expect(new OllamaEmbeddingProvider(8, 'wrong-dim', baseUrl).embed(['a'])).rejects.toThrow(/EMBEDDING_DIM=10/);
  });
});
