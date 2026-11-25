# Minions — Agentes e colaboração

## Contratos

Todos os tipos ficam em [`packages/core/src/agents/types.ts`](../packages/core/src/agents/types.ts).

| Contrato | Papel |
|---|---|
| `AgentTask` | Pedido de trabalho: agente, objetivo, consulta, quem pediu, profundidade, dicas (`areas`, `personIds`, `proposalIds`, `topic`) |
| `AgentResult` | Resultado: status (`ok`/`empty`/`failed`), resumo, achados literais com o trecho de origem, evidências, passos, pessoas, propostas e **pedidos** a outros agentes |
| `AgentRequest` | Pedido de colaboração (`to`, `objective`, `query`, `reason`, `hints`). Nunca é executado diretamente — o Orchestrator decide |
| `AgentTools` | Ferramentas **já vinculadas ao usuário** (busca, propostas, pessoas). Não há outro caminho de acesso a dados |
| `ChatAnswer` | Resposta final (contrato público em `contracts/`), consumida pela web e futuramente pelo Teams |

## Os cinco Minions

| Agente | Ferramentas | Estratégia | Pede ajuda a |
|---|---|---|---|
| **Orchestrator** | Todas (via barramento) | Intenção por regras (rápido, sem custo); LLM só quando as regras não são conclusivas. Despacha em ondas paralelas, decide pedidos, compara fontes, sintetiza | — |
| **Knowledge** | `searchKnowledge` | Busca híbrida; extrai literalmente frases que definem/respondem (prioriza definições) | Process, quando encontra procedimento e a pergunta é "como" |
| **Process** | `searchKnowledge` (com reforço para Procedimento/Manual/Modelo) | Reaproveita evidências do blackboard; extrai etapas numeradas na ordem do documento | People (responsável pela área dona do processo) |
| **Proposal** | `findProposals`, `searchKnowledge` (modelos e docs vinculados) | Código exato (ex.: `PRP-2025-014`) tem prioridade; dados vêm só do cadastro | People (responsável/equipe), Process (instruções de preenchimento) |
| **People** | `findExperts`, `getPeople` | Vínculos explícitos (responsável de proposta) > especialidades/responsabilidades > área dona dos documentos. Não indica o próprio usuário; oculta contato não autorizado | — |

## Fluxo de uma pergunta

```
pergunta ─▶ Orchestrator.plan (regras | LLM)            trace: plan
          ─▶ onda 1: agentes planejados em paralelo        trace: agent_start/agent_end
          ─▶ onda 2..maxDepth: pedidos aprovados           trace: agent_request / agent_skipped
             + complemento: People se houver conteúdo
          ─▶ seleção de evidências (relevância ≥ limiar, ACL já aplicada)
          ─▶ detecção de conflitos (mesma subject_key, valores divergentes)
          ─▶ síntese (Claude com saída estruturada | extrativa)   trace: synthesis
          ─▶ validação de citações; sem fundamento ⇒ "Não encontrei…"   trace: done
```

Exemplo real (dados fictícios), pergunta da colaboradora de Engenharia *"Preciso preencher uma planilha de uma proposta, mas não sei qual modelo utilizar"*:

```
plan        Intenção: proposal, procedure, document_lookup → proposal, process, knowledge
proposal    Modelo(s) de proposta encontrado(s); nenhuma proposta específica corresponde
process     5 etapa(s) extraída(s) de "Manual de Elaboração de Propostas Técnicas"
knowledge   8 trecho(s) relevante(s) em 4 documento(s)
skipped     proposal → process dispensado: passos já disponíveis
request     process → people: Processo pertence à área Comercial
people      Marcos Lima (responsável pelo modelo PT-03)
synthesis   → "Toda proposta técnica deve ser elaborada na planilha Modelo PT-03 [1] …" + 5 passos + fontes + responsável
```

## Controles de execução

| Controle | Onde | Padrão |
|---|---|---|
| Máx. chamadas de agentes por pergunta | `ExecutionBudget` | 8 |
| Profundidade de colaboração | `ExecutionBudget` | 2 ondas |
| Máx. chamadas ao modelo | `ExecutionBudget.tryConsumeLlmCall` | 6 (na prática 1–2) |
| Prazo total | `AbortController` + timeout por agente | 60 s |
| Ciclos/duplicatas | `AgentBus` — assinatura `agente:termos:dicas` | uma vez por pergunta |
| Chamadas desnecessárias | `Orchestrator.isUseful` | pula Process se já há passos; People se já há contatos |
| Reaproveitamento | `SessionResultCache` (usuário + permissões + conversa, TTL 10 min) | nunca entre usuários |

Todos ajustáveis em **Administração → Agentes** (persistidos na tabela `settings`, auditados).

## Memória de respostas

[`agents/memory.ts`](../packages/core/src/agents/memory.ts) — antes de acionar os agentes, o Orchestrator procura uma pergunta semelhante já respondida (busca vetorial na tabela `answer_memory`). A resposta só é reaproveitada se:

- a pergunta atual não depende do contexto da conversa;
- todas as versões de documentos usadas ainda são as atuais, ativas e **visíveis ao usuário atual** (ACL reavaliada em SQL);
- não envolve propostas (dados que mudam com frequência);
- o escopo permite: `user` (padrão, só do próprio usuário) ou `organization` (compartilhada, só perguntas independentes).

Contatos são recarregados do diretório no momento do uso. Respostas "insuficientes" nunca são memorizadas (o documento pode ser publicado depois). O admin pode limpar a memória.

## Uso do modelo de IA

- O Minions concentra as chamadas no Orchestrator (planejamento quando ambíguo + síntese). Os agentes especialistas usam ferramentas determinísticas — mais barato, rápido e auditável.
- Provedores: `none` (extrativo), `ollama` (local e gratuito — padrão deste ambiente, `qwen2.5:7b`) ou `anthropic` (pago). O validador aceita variações de citação de modelos menores (`"[S2]"` → `S2`), exige documentos distintos para apontar divergência e, se o modelo desistir com material suficiente, usa a resposta extrativa.
- Com Claude: modelo `claude-opus-5-5`, pensamento adaptativo, `effort` `low` no plano e `medium` na síntese, saída estruturada (JSON Schema) validada com zod.
- **Fallback de recusa do lado do servidor habilitado** (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). Desligue com `AI_REFUSAL_FALLBACK=off`.
- Prompt: documentos em `<document ref=… suspicious=…>` com conteúdo escapado; o system prompt declara documentos como dados não confiáveis.
- Se o modelo falhar, a resposta cai para o modo extrativo (testado).

## Como adicionar um agente

1. Adicione o id em `AGENT_IDS` e `AGENT_META` (`contracts/index.ts`).
2. Implemente `Agent` em `agents/workers/` usando apenas `ctx.tools` (adicione ferramentas em `AgentTools` sempre vinculadas ao `Principal`).
3. Registre em `DEFAULT_AGENTS` e em `agentsFor()` (intenção → agentes).
4. Cubra com teste em `apps/api/test/system.test.ts`.
