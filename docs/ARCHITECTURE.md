# Minions — Arquitetura

> Status: MVP (v0.1). Dados exclusivamente fictícios. Nenhum dado corporativo real deve ser carregado até a aprovação descrita em [HOSTING.md](HOSTING.md) e [SECURITY.md](SECURITY.md).

## 1. Análise inicial (Fase 1)

| Item | Situação encontrada | Decisão |
|---|---|---|
| Repositório | `D:\Minions` vazio, sem git | Monorepo novo com npm workspaces |
| Runtime | Node 24, npm 11 | TypeScript ESM em todo o código |
| Banco | — | Dev/testes usam **PGlite** (Postgres WASM com pgvector); nuvem usa **Neon** (Postgres gerenciado com pgvector) |
| Higgsfield MCP | Conectado, plano gratuito (10 créditos). `generate_image` retornou *"Requires basic plan or higher"* | Não utilizado. Identidade visual feita localmente (SVG + tokens CSS). Ver §7 |
| Integrações disponíveis | Vercel, Supabase, Render, Netlify, Google Drive (MCPs) | Nenhuma usada para dados; Vercel MCP só para consulta de docs. Integração com SharePoint/Drive fica atrás da interface `SourceConnector` (futuro) |

## 2. Visão geral

```
┌──────────────────────┐     ┌────────────────────────┐
│ Web (Next.js, BFF)   │     │ Microsoft Teams (futuro)│
│ UI + proxy /api/*    │     │ bot/tab → mesma API     │
└─────────┬────────────┘     └───────────┬────────────┘
          │ Bearer JWT (sessão httpOnly → proxy)      │ Entra ID token
          ▼                                           ▼
┌──────────────────────────────────────────────────────────┐
│ API (Hono, Node) — apps/api                              │
│ authn (dev JWT | OIDC/Entra) · RBAC · rate limit · audit │
│ /v1/chat (SSE) /v1/documents /v1/proposals /v1/people    │
│ /v1/admin  /v1/files/:token (link assinado)              │
└─────────┬────────────────────────────────────────────────┘
          │ chama somente @minions/core (sem HTTP no core)
          ▼
┌──────────────────────────────────────────────────────────┐
│ Núcleo de inteligência — packages/core                   │
│  agents/   Orchestrator + Knowledge/Process/Proposal/People│
│            AgentBus (orçamento, ciclos, memo, trace)       │
│  knowledge/ ingestão → validação → scan → extração →     │
│            chunking → embeddings → índice híbrido          │
│  auth/     política RBAC + ACL por documento (SQL)        │
│  ai/       LlmProvider (Gemini/Ollama) · Embeddings       │
│  storage/  StorageProvider (local | blob privado)         │
└─────────┬─────────────────────────────┬──────────────────┘
          ▼                             ▼
  PostgreSQL + pgvector          Armazenamento privado
  (PGlite em dev)                (filesystem em dev)
```

**Princípio central:** a interface não contém regra de negócio nem chama agentes. Web e o futuro bot do Teams falam com a mesma API; a API só traduz HTTP ↔ serviços do `core`.

## 3. Estrutura de diretórios

```
apps/
  api/            Hono: rotas, middlewares (auth, rate-limit, erros), SSE, worker, seed
  web/            Next.js App Router: UI, BFF proxy, sessão httpOnly
packages/
  core/src/
    contracts/    Schemas zod + tipos compartilhados (seguros para o browser)
    config/       Leitura/validação de variáveis de ambiente
    db/           Cliente (pg | PGlite), migrações SQL
    auth/         Principal, política RBAC/ACL, tokens, links assinados
    audit/        Trilha de auditoria
    ai/           Provedores LLM e embeddings
    storage/      Armazenamento de arquivos
    knowledge/    Ingestão, extratores, chunking, busca híbrida, conflitos
    agents/       Orquestrador, agentes, barramento, orçamento, síntese
    proposals/ people/ conversations/ admin/
seed/             Documentos e dados fictícios
docs/             Arquitetura, segurança, hospedagem, agentes, deploy
```

## 4. Multiagentes

Detalhes em [AGENTS.md](AGENTS.md). Resumo:

- **Orchestrator** classifica a intenção (LLM com saída estruturada ou classificador por regras quando não há modelo configurado), escolhe agentes, despacha em *ondas* paralelas, processa pedidos de colaboração entre agentes, detecta conflitos e sintetiza a resposta.
- **Comunicação estruturada:** agentes nunca chamam uns aos outros diretamente. Eles retornam `requests[]` (ex.: Process Agent pede ao People Agent o responsável pela área X). O Orchestrator decide se despacha — evita ciclos e chamadas desnecessárias.
- **Blackboard por requisição:** evidências, pessoas e propostas encontradas ficam visíveis aos agentes seguintes (reaproveitamento).
- **Controle de execução:** `ExecutionBudget` (máx. chamadas de agente, profundidade, chamadas LLM, prazo), assinatura de tarefa para detectar ciclos, memo de resultados por conversa, *trace* completo persistido e transmitido via SSE.

## 5. RAG

- Ingestão assíncrona por fila em tabela (`ingestion_jobs`, `FOR UPDATE SKIP LOCKED`) — funciona com um worker separado ou embutido na API em dev.
- Busca **híbrida**: similaridade vetorial (pgvector, cosseno) + full-text `portuguese` com `unaccent`, fundidas por *Reciprocal Rank Fusion*.
- **Autorização na consulta:** toda busca passa pela cláusula SQL gerada por `auth/policy.ts` (classificação ≤ habilitação do usuário E grupo/área permitidos). Um agente não tem como pedir trechos fora dessa cláusula.
- Respostas citam fontes `[S1]…`; o sintetizador valida que toda citação existe no conjunto recuperado. Sem evidência suficiente → mensagem fixa de insuficiência.

## 6. Decisões técnicas (ADR resumido)

| # | Decisão | Alternativas | Motivo |
|---|---|---|---|
| 1 | Monorepo npm workspaces, TS ESM | Turborepo/pnpm | Zero ferramenta extra; pnpm não instalado |
| 2 | API separada (Hono) + Next como BFF | Tudo em route handlers do Next | Permite hospedar o backend fora da Vercel (opção híbrida) e reutilizar no Teams |
| 3 | SQL explícito + migrações `.sql` | Prisma/Drizzle | Controle total de filtros de ACL, busca híbrida e RLS futura |
| 4 | PGlite em dev/teste, Postgres em homolog/prod | SQLite | Mesmo dialeto, pgvector e FTS em português; testes de isolamento rodam em CI sem Docker |
| 5 | LLM via API (Gemini/Ollama), orquestração em código | Managed Agents; frameworks de agentes | Fluxo controlado por código, dados ficam na infraestrutura própria, auditoria e limites determinísticos. Managed Agents hospedaria sessões na Anthropic — inadequado para documentos internos sem aprovação |
| 6 | Saída estruturada (JSON schema) + validação zod | Texto livre | Respostas com fontes verificáveis, sem parsing frágil |
| 7 | Modo **extrativo** sem LLM | Exigir chave de API | Dev/testes sem custo e sem enviar dados a terceiros; respostas compostas apenas de trechos recuperados, claramente rotuladas |
| 8 | Embeddings plugáveis (`hash` dev, Ollama, Gemini) | Um provedor fixo | Escolha depende do custo e do contrato; trocar de provedor exige reindexar |
| 10 | IA gratuita: Ollama local (`qwen2.5:7b` + `bge-m3`) e Gemini na nuvem | Provedores pagos | Custo zero. Provedores pagos (Claude, OpenAI) podem ser adicionados implementando `LlmProvider` quando houver orçamento |
| 11 | Memória de respostas com revalidação de ACL/versão | Cache por texto exato | Responde repetições sem IA e offline sem relaxar permissões |
| 9 | Links de download assinados (HMAC, 5 min) e revalidação de ACL no download | URLs públicas de blob | Evita URLs de armazenamento expostas |

## 7. Identidade visual

O nome "Minions" é uma marca registrada da Universal/Illumination no segmento de entretenimento. A identidade criada evita qualquer referência visual à franquia (sem amarelo, personagens ou óculos): o símbolo é uma constelação de cinco nós — um central (Orchestrator) e quatro satélites. Recomenda-se validação jurídica do nome antes de uso externo.

O Higgsfield não pôde gerar imagens (plano gratuito). Nenhum dado foi enviado a ele.
