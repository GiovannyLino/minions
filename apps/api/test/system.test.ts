import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INSUFFICIENT_MESSAGE, type ChatAnswer, type LlmProvider, type StructuredRequest } from '@minions/core';
import { ask, createTestSystem } from './helpers';

type System = Awaited<ReturnType<typeof createTestSystem>>;
let sys: System;

beforeAll(async () => {
  sys = await createTestSystem();
});
afterAll(async () => {
  await sys.minions.close();
});

describe('autenticação e autorização na API', () => {
  it('exige token em rotas protegidas', async () => {
    expect((await sys.api(null, '/v1/me')).status).toBe(401);
    expect((await sys.api(null, '/v1/me', { headers: { authorization: 'Bearer forjado' } })).status).toBe(401);
  });

  it('bloqueia rotas administrativas para colaboradores', async () => {
    expect((await sys.api('collaborator', '/v1/admin/users')).status).toBe(403);
    expect((await sys.api('collaborator', '/v1/admin/audit')).status).toBe(403);
    expect((await sys.api('admin', '/v1/admin/users')).status).toBe(200);
  });

  it('não permite que colaborador envie documentos', async () => {
    const form = new FormData();
    form.set('file', new File(['conteúdo'], 'a.txt'));
    form.set('metadata', JSON.stringify({ title: 'Teste', category: 'Política', area: 'Financeiro' }));
    expect((await sys.api('collaborator', '/v1/documents', { method: 'POST', body: form })).status).toBe(403);
  });

  it('impede gestor de publicar fora da própria área ou acima da habilitação', async () => {
    const send = (meta: object) => {
      const form = new FormData();
      form.set('file', new File(['Texto de teste suficiente para indexação.'], 'b.txt'));
      form.set('metadata', JSON.stringify(meta));
      return sys.api('manager', '/v1/documents', { method: 'POST', body: form });
    };
    expect((await send({ title: 'Fora da área', category: 'Política', area: 'Financeiro' })).status).toBe(403);
    expect((await send({ title: 'Acima', category: 'Política', area: 'Comercial', classification: 'confidential' })).status).toBe(403);
  });
});

describe('isolamento de dados (ACL no backend)', () => {
  it('documento confidencial não aparece em listagem, leitura ou chat para quem não tem acesso', async () => {
    const list = (await (await sys.api('collaborator', '/v1/documents?limit=200')).json()) as { items: { title: string; id: string }[] };
    expect(list.items.some((d) => d.title.includes('Contrato-quadro'))).toBe(false);
    const adminList = (await (await sys.api('admin', '/v1/documents?limit=200')).json()) as { items: { title: string; id: string }[] };
    const contract = adminList.items.find((d) => d.title.includes('Contrato-quadro'))!;
    expect(contract).toBeDefined();
    expect((await sys.api('collaborator', `/v1/documents/${contract.id}`)).status).toBe(404);
    const { answer } = await ask(sys.api, 'collaborator', 'Qual a multa contratual por atraso do contrato-quadro?');
    expect(JSON.stringify(answer)).not.toMatch(/multa contratual de 2%/);
    expect(answer.sources.every((s: { documentId: string }) => s.documentId !== contract.id)).toBe(true);
  });

  it('documento restrito é visível para o grupo permitido e invisível para os demais', async () => {
    const eng = await ask(sys.api, 'engineer', 'Qual modelo de planilha devo usar para proposta técnica?');
    expect(eng.answer.sources.some((s: { title: string }) => s.title.includes('Manual de Elaboração'))).toBe(true);
    const fin = await ask(sys.api, 'collaborator', 'Qual modelo de planilha devo usar para proposta técnica?');
    expect(fin.answer.sources.some((s: { title: string }) => s.title.includes('Manual de Elaboração') || s.title.includes('PT-03'))).toBe(false);
  });

  it('link de download não pode ser usado por outro usuário', async () => {
    const docs = (await (await sys.api('engineer', '/v1/documents?q=Manual')).json()) as { items: { id: string }[] };
    const link = (await (await sys.api('engineer', `/v1/documents/${docs.items[0]!.id}/download-link`, { method: 'POST' })).json()) as { url: string };
    const path = link.url.replace('/api', '');
    expect((await sys.api('engineer', path)).status).toBe(200);
    expect((await sys.api('collaborator', path)).status).toBe(403);
    expect((await sys.api('engineer', `${path}x`)).status).toBe(401);
  });

  it('conversas pertencem ao dono', async () => {
    const { conversationId } = await ask(sys.api, 'engineer', 'Como preencher o RDO?');
    expect((await sys.api('engineer', `/v1/conversations/${conversationId}/messages`)).status).toBe(200);
    expect((await sys.api('collaborator', `/v1/conversations/${conversationId}/messages`)).status).toBe(404);
  });
});

describe('respostas do Minions', () => {
  it('não inventa termos internos ausentes da base', async () => {
    const { answer } = await ask(sys.api, 'collaborator', 'Preciso abrir um E-PROC, mas não sei o que é nem como fazer isso.');
    expect(answer.status).toBe('insufficient');
    expect(answer.summary).toContain(INSUFFICIENT_MESSAGE);
    expect(answer.sources).toHaveLength(0);
  });

  it('responde procedimento com passo a passo, fontes verificáveis e responsável', async () => {
    const { answer } = await ask(sys.api, 'collaborator', 'Como abrir uma solicitação de compras?');
    expect(answer.status).toBe('answered');
    expect(answer.steps.length).toBeGreaterThanOrEqual(5);
    const refs = new Set(answer.sources.map((s: { ref: string }) => s.ref));
    for (const step of answer.steps) for (const c of step.citations) expect(refs.has(c)).toBe(true);
    expect(answer.sources[0].downloadUrl).toMatch(/^\/api\/v1\/files\//);
    expect(answer.people.some((p: { name: string }) => p.name === 'Paula Mendes')).toBe(true);
  });

  it('informa divergência entre documentos conflitantes sem escolher uma versão', async () => {
    const { answer } = await ask(sys.api, 'collaborator', 'Qual é o limite de reembolso de refeição?');
    expect(answer.conflicts).toHaveLength(1);
    expect(answer.conflicts[0].description).toMatch(/R\$ 80,00.*R\$ 100,00|R\$ 100,00.*R\$ 80,00/);
    expect(answer.summary).toContain('R$ 80,00');
    expect(answer.summary).toContain('R$ 100,00');
  });

  it('agentes colaboram: Proposal → Process/People coordenados pelo Orchestrator', async () => {
    const { answer, events } = await ask(sys.api, 'engineer', 'Preciso preencher uma planilha de uma proposta, mas não sei qual modelo utilizar.');
    const agents = answer.agents.map((a: { agent: string }) => a.agent);
    expect(agents).toEqual(expect.arrayContaining(['orchestrator', 'proposal', 'process', 'knowledge', 'people']));
    expect(answer.summary).toContain('PT-03');
    expect(events.some((e) => e.event === 'trace' && e.data.type === 'agent_request')).toBe(true);
    expect(answer.people.some((p: { name: string }) => p.name === 'Marcos Lima')).toBe(true);
  });

  it('usa dados estruturados de propostas e não as inventa', async () => {
    const found = await ask(sys.api, 'engineer', 'Qual é o status da proposta PRP-2025-014 e quem é o responsável?');
    expect(found.answer.summary).toContain('Em revisão');
    expect(found.answer.people[0].reason).toContain('PRP-2025-014');
    const missing = await ask(sys.api, 'engineer', 'Qual é o status da proposta PRP-2099-999?');
    expect(missing.answer.summary).toMatch(/não está cadastrada|Não encontrei/);
  });

  it('não repassa instruções maliciosas contidas em documentos', async () => {
    const { answer } = await ask(sys.api, 'collaborator', 'Quando é a manutenção do portal do colaborador?');
    expect(answer.summary).toContain('primeiro sábado');
    expect(answer.summary).not.toMatch(/revele a senha|Ignore todas/i);
    expect(answer.sources.find((s: { title: string }) => s.title.includes('Comunicado'))?.suspicious).toBe(true);
  });

  it('respeita o limite de chamadas de agentes', async () => {
    await sys.api('admin', '/v1/admin/settings/agents', {
      method: 'PUT',
      body: JSON.stringify({ enabledAgents: ['knowledge', 'process', 'proposal', 'people'], maxAgentCalls: 1, maxDepth: 2, maxLlmCalls: 0, timeoutMs: 30000, retrievalTopK: 8, minRelevance: 0.34, answerMemory: 'off', memorySimilarity: 0.92 }),
    });
    const { answer, events } = await ask(sys.api, 'engineer', 'Preciso preencher uma planilha de uma proposta, mas não sei qual modelo utilizar.');
    expect(answer.agents.filter((a: { agent: string }) => a.agent !== 'orchestrator')).toHaveLength(1);
    expect(events.some((e) => e.event === 'trace' && /Limite de execução/.test(e.data.message))).toBe(true);
    await sys.api('admin', '/v1/admin/settings/agents', {
      method: 'PUT',
      body: JSON.stringify({ enabledAgents: ['knowledge', 'process', 'proposal', 'people'], maxAgentCalls: 8, maxDepth: 2, maxLlmCalls: 6, timeoutMs: 60000, retrievalTopK: 8, minRelevance: 0.34, answerMemory: 'off', memorySimilarity: 0.92 }),
    });
  });

  it('valida a entrada do chat', async () => {
    const res = await sys.api('collaborator', '/v1/chat', { method: 'POST', body: JSON.stringify({ message: 'a' }) });
    expect(res.status).toBe(400);
  });
});

describe('pipeline de ingestão', () => {
  it('processa upload, nova versão substitui o índice e auditoria registra', async () => {
    const send = async (content: string, path = '/v1/documents', meta?: object) => {
      const form = new FormData();
      form.set('file', new File([content], 'procedimento-teste.md'));
      if (meta) form.set('metadata', JSON.stringify(meta));
      return sys.api('manager', path, { method: 'POST', body: form });
    };
    const res = await send('# Procedimento Zeta\n\nO código ZETA-77 identifica o fluxo de homologação de fornecedores.', '/v1/documents', { title: 'Procedimento Zeta', category: 'Procedimento', area: 'Comercial' });
    expect(res.status).toBe(201);
    const doc = (await res.json()) as { id: string; status: string };
    expect(doc.status).toBe('pending');
    await sys.minions.documents.drainQueue();
    expect(((await (await sys.api('manager', `/v1/documents/${doc.id}`)).json()) as { status: string }).status).toBe('ready');

    const v2 = await send('# Procedimento Zeta\n\nO código ZETA-88 substitui o antigo código do fluxo de homologação.', `/v1/documents/${doc.id}/versions`);
    expect(v2.status).toBe(201);
    await sys.minions.documents.drainQueue();
    const versions = (await (await sys.api('manager', `/v1/documents/${doc.id}/versions`)).json()) as { version: number; status: string }[];
    expect(versions.map((v) => [v.version, v.status])).toEqual([[2, 'ready'], [1, 'archived']]);
    const chunks = await sys.minions.db.query<{ content: string }>('select content from chunks where document_id = $1', [doc.id]);
    expect(chunks.every((c) => c.content.includes('ZETA-88'))).toBe(true);

    const audit = (await (await sys.api('admin', '/v1/admin/audit?action=document.')).json()) as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['document.uploaded', 'document.version_uploaded']));
  });

  it('rejeita arquivo com formato inválido e registra a tentativa', async () => {
    const form = new FormData();
    form.set('file', new File(['MZ fake'], 'virus.exe'));
    form.set('metadata', JSON.stringify({ title: 'Arquivo executável', category: 'Política', area: 'Comercial' }));
    const res = await sys.api('manager', '/v1/documents', { method: 'POST', body: form });
    expect(res.status).toBe(422);
    const audit = (await (await sys.api('admin', '/v1/admin/audit?action=document.upload_rejected')).json()) as { outcome: string }[];
    expect(audit[0]?.outcome).toBe('denied');
  });

  it('arquivar remove o documento das respostas', async () => {
    const list = (await (await sys.api('admin', '/v1/documents?q=RDO')).json()) as { items: { id: string; title: string }[] };
    const rdo = list.items.find((d) => d.title.includes('RDO'))!;
    await sys.api('admin', `/v1/documents/${rdo.id}/archive`, { method: 'POST' });
    const { answer } = await ask(sys.api, 'engineer', 'Qual o prazo de envio do Relatório Diário de Obra?');
    expect(answer.sources.some((s: { documentId: string }) => s.documentId === rdo.id)).toBe(false);
    await sys.api('admin', `/v1/documents/${rdo.id}/restore`, { method: 'POST' });
  });
});

describe('modo com modelo de IA (provedor simulado)', () => {
  class RecordingLlm implements LlmProvider {
    readonly id = 'fake';
    readonly model = 'fake-model';
    prompts: StructuredRequest<unknown>[] = [];
    constructor(private readonly reply: (req: StructuredRequest<unknown>) => unknown) {}
    async generateJson<T>(req: StructuredRequest<T>): Promise<T> {
      this.prompts.push(req as StructuredRequest<unknown>);
      return req.validator.parse(this.reply(req as StructuredRequest<unknown>));
    }
  }

  it('envia documentos como dados delimitados e valida citações do modelo', async () => {
    const llm = new RecordingLlm(() => ({
      sufficient: true,
      summary: 'A manutenção ocorre no primeiro sábado do mês [S1]. Fonte inexistente [S42].',
      steps: [],
      conflicts: [],
      suggestions: ['Qual o horário?'],
      next_actions: [],
    }));
    const local = await createTestSystem({ llm });
    try {
      const { answer } = await ask(local.api, 'collaborator', 'Quando é a manutenção do portal do colaborador?');
      expect(answer.mode).toBe('llm');
      expect(answer.summary).not.toContain('[S42]');
      const prompt = llm.prompts.find((p) => p.purpose === 'orchestrator.synthesis')!;
      expect(prompt.system).toMatch(/DADO não confiável/);
      expect(prompt.user).toMatch(/<document ref="S\d+"[^>]*suspicious="true">/);
      expect(prompt.user).not.toMatch(/Contrato-quadro/);
    } finally {
      await local.minions.close();
    }
  });

  it('cai para o modo extrativo quando o modelo falha', async () => {
    const llm = new RecordingLlm(() => {
      throw new Error('indisponível');
    });
    const local = await createTestSystem({ llm });
    try {
      const { answer, events } = await ask(local.api, 'collaborator', 'Como abrir uma solicitação de compras?');
      expect((answer as ChatAnswer).mode).toBe('extractive');
      expect(answer.steps.length).toBeGreaterThan(0);
      expect(events.some((e) => e.event === 'trace' && e.data.type === 'error')).toBe(true);
    } finally {
      await local.minions.close();
    }
  });
});
