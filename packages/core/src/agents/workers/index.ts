import { stripAccents } from '../../knowledge/text';
import { anchorTerms } from '../../knowledge/search';
import { emptyResult, type Agent, type AgentRequest, type AgentResult } from '../types';
import { extractFindings, extractSteps } from './extraction';

type Partial = Omit<AgentResult, 'durationMs' | 'taskId' | 'agent'>;

const PROCESS_CATEGORIES: Record<string, number> = { Procedimento: 1.6, Manual: 1.4, Modelo: 1.3, 'Formulário': 1.3, Sistema: 1.3 };

/**
 * Agent 02 — Knowledge: conceitos, políticas e normas. Busca híbrida na base autorizada e extrai
 * literalmente as frases que respondem à pergunta. Pede ao Process Agent quando percebe um procedimento.
 */
export const knowledgeAgent: Agent = {
  id: 'knowledge',
  async run(task, ctx): Promise<Partial> {
    const evidence = (await ctx.tools.searchKnowledge(task.query, { topK: ctx.settings.retrievalTopK })).filter((e) => e.relevance >= ctx.settings.minRelevance);
    if (evidence.length === 0) return emptyResult('Nenhum documento autorizado trata deste assunto');
    const findings = extractFindings(task.query, evidence);
    const requests: AgentRequest[] = [];
    const procedural = evidence.find((e) => e.category in PROCESS_CATEGORIES);
    if (procedural && ctx.intents.includes('procedure')) {
      requests.push({ to: 'process', objective: 'Extrair o passo a passo do procedimento encontrado', query: task.query, reason: `Documento de procedimento: ${procedural.title}` });
    }
    const docs = new Set(evidence.map((e) => e.title));
    return {
      status: 'ok',
      summary: `${evidence.length} trecho(s) relevante(s) em ${docs.size} documento(s)`,
      findings,
      evidence,
      steps: [],
      people: [],
      proposals: [],
      requests,
    };
  },
};

/**
 * Agent 03 — Process: procedimentos, sistemas, formulários e planilhas. Prioriza documentos de
 * procedimento/modelo e extrai etapas na ordem do documento. Pede ao People Agent o responsável pela área.
 */
export const processAgent: Agent = {
  id: 'process',
  async run(task, ctx): Promise<Partial> {
    const fromBoard = [...ctx.blackboard.evidence.values()].filter((e) => e.category in PROCESS_CATEGORIES && e.relevance >= ctx.settings.minRelevance);
    const searched = await ctx.tools.searchKnowledge(task.query, { topK: ctx.settings.retrievalTopK, categoryBoost: PROCESS_CATEGORIES });
    const evidence = dedupe([...fromBoard, ...searched]).filter((e) => e.relevance >= ctx.settings.minRelevance);
    if (evidence.length === 0) return emptyResult('Nenhum procedimento autorizado encontrado');
    const procedural = evidence.filter((e) => e.category in PROCESS_CATEGORIES);
    const steps = extractSteps(procedural.length ? procedural : evidence);
    const top = (procedural[0] ?? evidence[0])!;
    const requests: AgentRequest[] = [
      { to: 'people', objective: `Identificar responsável pelo processo na área ${top.area}`, query: task.query, reason: `Processo pertence à área ${top.area}`, hints: { areas: [top.area], topic: task.query } },
    ];
    return {
      status: 'ok',
      summary: steps.length ? `${steps.length} etapa(s) extraída(s) de "${top.title}"` : `Procedimento relacionado: "${top.title}" (sem etapas numeradas)`,
      findings: extractFindings(task.query, evidence, 2),
      evidence,
      steps,
      people: [],
      proposals: [],
      requests,
    };
  },
};

/**
 * Agent 04 — Proposal: propostas e projetos a partir do cadastro estruturado (nunca inventa dados).
 * Busca documentos vinculados e modelos; pede ao People Agent os responsáveis e ao Process Agent
 * as instruções de preenchimento quando a pergunta envolve planilhas/modelos.
 */
export const proposalAgent: Agent = {
  id: 'proposal',
  async run(task, ctx): Promise<Partial> {
    const matches = await ctx.tools.findProposals(task.query);
    const wantsFilling = /preench|planilha|modelo|template|formulario/.test(stripAccents(task.query.toLowerCase()));
    const requests: AgentRequest[] = [];
    let evidence = [] as Awaited<ReturnType<typeof ctx.tools.searchKnowledge>>;

    if (wantsFilling) {
      const templates = await ctx.tools.searchKnowledge(`modelo planilha proposta ${task.query}`, { topK: 4, categories: ['Modelo', 'Formulário'] });
      evidence = templates.filter((e) => e.relevance >= ctx.settings.minRelevance);
      requests.push({ to: 'process', objective: 'Encontrar as instruções de preenchimento do modelo de proposta', query: `instruções preenchimento planilha proposta ${anchorTerms(task.query).join(' ')}`, reason: 'Pergunta envolve preenchimento de modelo' });
    }

    if (matches.length === 0) {
      return {
        ...emptyResult(wantsFilling && evidence.length ? `Modelo(s) de proposta encontrado(s); nenhuma proposta específica cadastrada corresponde` : 'Nenhuma proposta cadastrada corresponde à pergunta'),
        status: evidence.length ? 'ok' : 'empty',
        evidence,
        requests,
      };
    }

    const proposals = matches.map((m) => m.proposal);
    const main = proposals[0]!;
    const linked = await ctx.tools.searchKnowledge(task.query, { topK: 4, proposalId: main.id });
    evidence = dedupe([...evidence, ...linked.filter((e) => e.relevance >= ctx.settings.minRelevance * 0.5)]);
    const personIds = [main.ownerPersonId, ...main.memberPersonIds].filter((x): x is string => Boolean(x));
    if (personIds.length) {
      requests.push({ to: 'people', objective: `Identificar responsáveis pela proposta ${main.code}`, query: `${main.code} ${main.name}`, reason: 'Proposta possui responsável/equipe cadastrados', hints: { personIds, proposalIds: [main.id], areas: [main.area] } });
    }
    return {
      status: 'ok',
      summary: `Proposta ${main.code} — ${main.name}${proposals.length > 1 ? ` (+${proposals.length - 1} relacionada(s))` : ''}`,
      findings: [],
      evidence,
      steps: [],
      people: [],
      proposals,
      requests,
    };
  },
};

/**
 * Agent 05 — People: conecta o colaborador a quem sabe. Usa responsáveis cadastrados (propostas),
 * áreas donas dos documentos encontrados e especialidades declaradas. Só expõe contatos autorizados.
 */
export const peopleAgent: Agent = {
  id: 'people',
  async run(task, ctx): Promise<Partial> {
    const out = new Map<string, { person: Awaited<ReturnType<typeof ctx.tools.getPeople>>[number]; reason: string }>();
    const hints = task.hints ?? {};
    if (hints.personIds?.length) {
      const proposal = hints.proposalIds?.length ? ctx.blackboard.proposals.get(hints.proposalIds[0]!) : undefined;
      for (const person of await ctx.tools.getPeople(hints.personIds)) {
        const isOwner = proposal?.ownerPersonId === person.id;
        out.set(person.id, { person, reason: proposal ? (isOwner ? `Responsável pela proposta ${proposal.code}` : `Equipe da proposta ${proposal.code}`) : 'Responsável cadastrado' });
      }
    }
    const areas = hints.areas?.length ? hints.areas : ctx.blackboard.evidenceAreas(ctx.settings.minRelevance).slice(0, 1);
    const experts = await ctx.tools.findExperts(hints.topic ?? task.query, areas);
    for (const m of experts) if (!out.has(m.person.id)) out.set(m.person.id, { person: m.person, reason: m.reason });
    // Não indica o próprio usuário como contato.
    const people = [...out.values()].filter((p) => p.person.userId !== ctx.principal.id).slice(0, 3);
    if (people.length === 0) return emptyResult('Nenhum responsável ou especialista cadastrado para o tema');
    return {
      status: 'ok',
      summary: `${people.length} pessoa(s) indicada(s): ${people.map((p) => p.person.name).join(', ')}`,
      findings: [],
      evidence: [],
      steps: [],
      people,
      proposals: [],
      requests: [],
    };
  },
};

function dedupe<T extends { chunkId: string; score: number }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const i of items) {
    const prev = map.get(i.chunkId);
    if (!prev || prev.score < i.score) map.set(i.chunkId, i);
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

export const DEFAULT_AGENTS: Agent[] = [knowledgeAgent, processAgent, proposalAgent, peopleAgent];
