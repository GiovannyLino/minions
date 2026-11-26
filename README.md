# Minions

Plataforma de conhecimento corporativo com cinco agentes de IA que colaboram — **Orchestrator, Knowledge, Process, Proposal e People** — sobre uma base RAG com permissões aplicadas no backend.

> ⚠️ Ambiente de demonstração: todos os dados em `seed/` são **fictícios** ("Exemplo S.A."). Não carregue informações reais antes do checklist em [docs/SECURITY.md](docs/SECURITY.md) §6.

## Início rápido

Requisitos: Node.js ≥ 20.11 (testado com 24). Não precisa de Docker — o desenvolvimento usa PGlite (Postgres embutido com pgvector).

```powershell
npm install
```

```powershell
Copy-Item .env.example .env
```

Gere um `AUTH_SECRET` e cole no `.env`:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```powershell
npm run seed
```

```powershell
npm run dev
```

Abra http://localhost:3000 e escolha um usuário fictício (admin, gestor ou colaboradores).

### Perguntas para experimentar

| Pergunta | O que demonstra |
|---|---|
| Preciso abrir um E-PROC, mas não sei o que é nem como fazer isso. | Não inventa termos internos: responde que não encontrou |
| Como abrir uma solicitação de compras? | Passo a passo com citações + responsável (Process → People) |
| Preciso preencher uma planilha de uma proposta, mas não sei qual modelo utilizar. | Colaboração Proposal / Process / Knowledge / People (como Carla) |
| Qual é o limite de reembolso de refeição em viagem? | Documentos conflitantes: mostra a divergência, não escolhe versão |
| Qual é o status da proposta PRP-2025-014? | Dados estruturados de propostas + equipe (Carla vê; Diego não) |
| Quais as penalidades do contrato do Cliente Fictício Alfa? | Isolamento: só a admin recebe o conteúdo confidencial |

CLI de desenvolvimento (mostra o rastreamento dos agentes):

```powershell
npm run ask -w @minions/api -- --as carla "Como preencher o RDO?"
```

## Modo de IA

| `LLM_PROVIDER` | Custo | Comportamento |
|---|---|---|
| `none` (padrão) | Grátis | **Modo extrativo**: respostas compostas só de trechos literais dos documentos. Nenhum dado sai da máquina |
| `gemini` | Grátis (plano gratuito do Google AI Studio) | Google Gemini redige a resposta com saída estruturada e citações validadas. No plano gratuito o Google pode usar o conteúdo — **só dados fictícios** (o sistema recusa `ALLOW_REAL_DATA=true` sem `GEMINI_PAID_TIER=true`) |
| `ollama` | Grátis (roda no seu computador/servidor) | Modelo local via [Ollama](https://ollama.com) redige a resposta com saída estruturada e citações validadas. Documentos não saem da máquina |
| `anthropic` | Pago por uso | Claude (`claude-opus-5-5`). Use só com orçamento aprovado |

Embeddings: `hash` (grátis, lexical, só dev) · `gemini` (grátis, semântico, `EMBEDDING_DIM=768`) · `ollama` (grátis, semântico) · `voyage` / `openai` (pagos).

### Funcionamento offline e custo zero

Nesta máquina o Minions já está configurado para rodar **sem internet e sem custo**: modelo `qwen2.5:7b` e embeddings `bge-m3` via Ollama (GPU local), banco PGlite, fontes empacotadas e telemetria do Next desligada. O painel mostra o selo "Funciona offline · custo zero" e Administração → Visão geral confirma.

Camadas de resposta, da mais barata para a mais cara — todas locais:

1. **Memória de respostas** — pergunta repetida (similaridade ≥ 0,92) é respondida em milissegundos, sem IA, depois de revalidar que as fontes continuam na mesma versão e visíveis ao usuário. Por padrão a memória é por usuário (Administração → Agentes).
2. **Modelo local (Ollama)** — redige a resposta a partir dos trechos autorizados, com citações validadas.
3. **Modo extrativo** — se o Ollama estiver desligado, ou se o modelo não conseguir redigir com segurança, a resposta é montada só com trechos literais dos documentos.

### IA gratuita com Ollama (instalação em outra máquina)

Requer ~8 GB de RAM para um modelo de 7B (use `llama3.2:3b` em máquinas modestas). Depois de instalar o Ollama:

```powershell
ollama pull qwen2.5:7b
```

```powershell
ollama pull bge-m3
```

No `.env`: `LLM_PROVIDER=ollama`, e para busca semântica `EMBEDDING_PROVIDER=ollama`, `EMBEDDING_MODEL=bge-m3`, `EMBEDDING_DIM=1024`. Trocar os embeddings exige recriar o índice (`npm run seed -w @minions/api -- --force`). Se o Ollama estiver desligado, o Minions responde no modo extrativo automaticamente.

## Publicar na nuvem com link fixo (grátis) — recomendado

**Vercel + Neon (Postgres em São Paulo) + Gemini**: link fixo, não depende do seu PC ligado, mesmas camadas de segurança (código de acesso, ACL, auditoria, rate limit). Passo a passo em **[docs/VERCEL.md](docs/VERCEL.md)** (~10 min).

## Compartilhar a partir do seu PC (grátis)

O Minions roda no seu computador (IA na sua GPU, documentos locais) e é publicado por um **Cloudflare Tunnel** — link HTTPS público, sem conta e sem custo. Só o site é exposto; API, Ollama e banco continuam acessíveis apenas na sua máquina.

Pré-requisito (uma vez):

```powershell
winget install Cloudflare.cloudflared
```

Feche qualquer `npm run dev` aberto e rode:

```powershell
npm run share
```

O terminal mostra o **link** (`https://….trycloudflare.com`) e um **código de acesso**. Envie os dois só para quem deve testar: ninguém vê nenhuma página sem o código (5 tentativas erradas bloqueiam por 10 min). Para encerrar, `Ctrl+C` — o link deixa de funcionar e a API salva o banco antes de sair.

- O link muda a cada execução e só funciona com o PC ligado. Para um endereço fixo e login por e-mail, use um *named tunnel* com Cloudflare Access (gratuito até 50 usuários, exige um domínio na Cloudflare).
- Use `DEMO_ACCESS_CODE=...` para fixar o código; `npm run share -- --skip-build` reaproveita o build anterior.
- Os usuários fictícios (inclusive o administrador) ficam disponíveis para quem tem o código. **Não carregue dados reais** nesse modo.

### Se algo não iniciar

| Mensagem | Causa e solução |
|---|---|
| "A porta 3000/4000 já está em uso" | Outra instância (`npm run dev`/`share`) está aberta. Feche-a com `Ctrl+C` |
| "O banco local já está em uso por outra instância" | Idem. Dois processos no mesmo banco o corrompem, por isso o Minions recusa |
| "Banco local danificado… restaurando" | Encerramento abrupto. O Minions restaura sozinho o último backup (feito a cada 10 min e ao encerrar) e guarda a pasta danificada |
| "danificado e não há backup" | Recrie a base de demonstração: `npm run seed -w @minions/api -- --force` |

A primeira pergunta após iniciar pode levar alguns segundos a mais; os modelos são pré-carregados na GPU ao subir a API e ficam carregados por 30 min.

## Login corporativo (Entra ID)

Para testar o fluxo completo localmente, sem tenant real, use o IdP de desenvolvimento embutido:

```powershell
npm run dev:sso
```

Em http://localhost:3000, "Entrar com a conta corporativa" leva ao IdP de teste (identidades fictícias com app roles e grupos no formato do Entra). A configuração do Entra real está em [docs/DEPLOY.md](docs/DEPLOY.md) §4.

## Estrutura

```
apps/api      API HTTP (Hono): auth, RBAC, rate limit, SSE do chat, worker de ingestão, seed
apps/web      Next.js 16: UI + BFF (/api/*) com sessão em cookie httpOnly
packages/core Núcleo independente de interface: agentes, RAG, ingestão, ACL, auditoria
seed/         Documentos fictícios
docs/         Arquitetura, segurança, hospedagem, agentes, deploy, Teams
```

## Scripts

| Comando | Função |
|---|---|
| `npm run dev` | API (:4000) + web (:3000) |
| `npm run seed` / `npm run seed -w @minions/api -- --force` | Carrega dados fictícios / recria a base local (pare o `npm run dev` antes) |
| `npm test` | 68 testes (unidade, integração, isolamento, ingestão, agentes, OIDC, Ollama, Gemini, nuvem, memória) |
| `npm run seed:cloud -w @minions/api` | Carrega os dados fictícios no banco da nuvem (lê `.env.cloud`) |
| `npm run dev:sso` | API + web em modo OIDC com IdP de desenvolvimento |
| `npm run share` | Publica o Minions do seu PC com link público + código de acesso |
| `npm run typecheck` | Checagem de tipos de todos os pacotes |
| `npm run build` | Build de produção do web |
| `npm run worker -w @minions/api` | Worker de ingestão separado (requer `DATABASE_URL`) |

## Documentação

- [Arquitetura e decisões](docs/ARCHITECTURE.md)
- [Agentes e colaboração](docs/AGENTS.md)
- [Segurança e LGPD](docs/SECURITY.md)
- [Avaliação de hospedagem (Vercel × Azure × híbrida)](docs/HOSTING.md)
- [Nuvem grátis: Vercel + Neon + Gemini](docs/VERCEL.md)
- [Publicação corporativa](docs/DEPLOY.md)
- [Microsoft Teams](docs/TEAMS.md)
