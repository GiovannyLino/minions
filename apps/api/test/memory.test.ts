import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ask, createTestSystem } from './helpers';

let sys: Awaited<ReturnType<typeof createTestSystem>>;
const settings = (answerMemory: 'off' | 'user' | 'organization') =>
  sys.api('admin', '/v1/admin/settings/agents', {
    method: 'PUT',
    body: JSON.stringify({ enabledAgents: ['knowledge', 'process', 'proposal', 'people'], maxAgentCalls: 8, maxDepth: 2, maxLlmCalls: 6, timeoutMs: 60000, retrievalTopK: 8, minRelevance: 0.34, answerMemory, memorySimilarity: 0.92 }),
  });

beforeAll(async () => {
  sys = await createTestSystem();
});
afterAll(async () => {
  await sys.minions.close();
});

describe('memória de respostas (offline, sem IA)', () => {
  it('reaproveita a resposta de uma pergunta repetida pelo mesmo usuário', async () => {
    const first = await ask(sys.api, 'collaborator', 'Como abrir uma solicitação de compras?');
    expect(first.answer.mode).toBe('extractive');
    const again = await ask(sys.api, 'collaborator', 'Como abrir uma solicitação de compras?');
    expect(again.answer.mode).toBe('memory');
    expect(again.answer.memory.similarity).toBeGreaterThan(0.99);
    expect(again.answer.steps).toHaveLength(first.answer.steps.length);
    expect(again.answer.sources[0].downloadUrl).toMatch(/^\/api\/v1\/files\//);
    expect(again.events.some((e) => e.event === 'trace' && e.data.type === 'memory')).toBe(true);
    expect(again.answer.agents.map((a: { agent: string }) => a.agent)).toEqual(['orchestrator']);
  });

  it('no escopo por usuário, nunca compartilha com outra pessoa', async () => {
    const other = await ask(sys.api, 'engineer', 'Como abrir uma solicitação de compras?');
    expect(other.answer.mode).not.toBe('memory');
  });

  it('no escopo da organização, compartilha só quando o usuário pode ver todas as fontes', async () => {
    await settings('organization');
    await ask(sys.api, 'engineer', 'Qual modelo de planilha devo usar para proposta técnica?');
    const allowed = await ask(sys.api, 'manager', 'Qual modelo de planilha devo usar para proposta técnica?');
    expect(allowed.answer.mode).toBe('memory');
    const denied = await ask(sys.api, 'collaborator', 'Qual modelo de planilha devo usar para proposta técnica?');
    expect(denied.answer.mode).not.toBe('memory');
    expect(denied.answer.sources.every((s: { classification: string }) => s.classification !== 'restricted')).toBe(true);
    await settings('user');
  });

  it('não reaproveita quando um documento-fonte ganhou nova versão', async () => {
    await ask(sys.api, 'collaborator', 'Qual é o prazo para enviar o pedido de reembolso?');
    const docs = (await (await sys.api('admin', '/v1/documents?q=Reembolso')).json()) as { items: { id: string; title: string }[] };
    const doc = docs.items.find((d) => d.title.includes('2025'))!;
    const form = new FormData();
    form.set('file', new File(['# Política de Reembolso de Despesas (edição 2025)\n\n## Prazo\nO pedido de reembolso deve ser enviado em até 20 dias após a despesa.'], 'politica-reembolso-2025.md'));
    expect((await sys.api('admin', `/v1/documents/${doc.id}/versions`, { method: 'POST', body: form })).status).toBe(201);
    await sys.minions.documents.drainQueue();
    const again = await ask(sys.api, 'collaborator', 'Qual é o prazo para enviar o pedido de reembolso?');
    expect(again.answer.mode).not.toBe('memory');
    expect(again.answer.summary).toContain('20 dias');
  });

  it('perguntas de acompanhamento não usam nem alimentam a memória', async () => {
    const first = await ask(sys.api, 'engineer', 'Como preencher o RDO?');
    const follow = await ask(sys.api, 'engineer', 'e quem é o responsável?', first.conversationId);
    expect(follow.answer.mode).not.toBe('memory');
    const stats = await sys.minions.memory.stats();
    const rows = await sys.minions.db.query<{ question: string }>('select question from answer_memory');
    expect(rows.some((r) => r.question.includes('responsável?'))).toBe(false);
    expect(stats.entries).toBeGreaterThan(0);
  });

  it('admin pode limpar a memória', async () => {
    expect((await sys.api('collaborator', '/v1/admin/memory', { method: 'DELETE' })).status).toBe(403);
    const res = (await (await sys.api('admin', '/v1/admin/memory', { method: 'DELETE' })).json()) as { removed: number };
    expect(res.removed).toBeGreaterThan(0);
    expect((await sys.minions.memory.stats()).entries).toBe(0);
  });
});
