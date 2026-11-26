# Minions na nuvem grátis — Vercel + Neon + Gemini

Publica a demonstração com **link fixo**, sem depender do seu PC ligado e **sem custo**:

```
Navegador ──HTTPS──▶ Vercel (gru1, São Paulo)
                     Next.js: telas + BFF + API do Minions embutida (uma função serverless)
                       │                                   │
                       ▼                                   ▼
            Neon Postgres (aws sa-east-1, São Paulo)   Google Gemini (plano gratuito)
            banco + pgvector + arquivos (file_blobs)   respostas e embeddings
```

| Peça | Plano grátis | Observação |
|---|---|---|
| [Vercel](https://vercel.com) Hobby | Sim | Uso **pessoal e não comercial**. Para uso pela empresa, plano Pro |
| [Neon](https://neon.tech) Free | Sim (0,5 GB) | Hiberna sem uso e acorda sozinho em ~1 s |
| [Gemini API](https://aistudio.google.com/apikey) Free | Sim, sem cartão | **O Google pode usar o conteúdo enviado para melhorar os produtos dele** → só dados fictícios |

> **Segurança preservada:** portão com código de acesso antes de qualquer página, login de usuários fictícios só atrás do portão, ACL aplicada no SQL antes de qualquer trecho ir ao Gemini, CSRF/headers/CSP do BFF, auditoria, rate limit guardado no banco (vale para todas as instâncias), cookies `httpOnly`/`secure`. O sistema **se recusa a iniciar** se: faltar `DEMO_ACCESS_CODE` (mínimo 12 caracteres), `ALLOW_REAL_DATA=true` com Gemini gratuito, ou Vercel sem banco externo.

## 1. Gemini — chave gratuita (2 min)

1. Entre em https://aistudio.google.com/apikey com uma conta Google e clique em **Create API key**.
2. **Não** ative o faturamento: sem faturamento não há cobrança possível — ao atingir o limite gratuito o Gemini só responde "tente de novo" e o Minions cai para o modo extrativo (trechos literais).
3. Os limites gratuitos de cada modelo aparecem em https://aistudio.google.com/rate-limit.

## 2. Neon — banco Postgres (3 min)

1. Crie a conta em https://neon.tech → **New project** → região **AWS São Paulo (sa-east-1)** → Postgres 17.
2. Em **Connection details**, ative **Pooled connection** e copie a URL (`postgresql://…-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require`).
   Troque `sslmode=require` por **`sslmode=verify-full`** (verificação completa do certificado; o driver avisa que `require` ficará mais fraco).
   As extensões `vector` e `unaccent` são criadas automaticamente pela primeira migração.

## 3. Carregar os dados fictícios no Neon (do seu PC, uma vez)

Copie [`.env.cloud.example`](../.env.cloud.example) para `.env.cloud` na raiz (o arquivo é ignorado pelo git), preencha `DATABASE_URL`, `GEMINI_API_KEY`, `AUTH_SECRET` e `DEMO_ACCESS_CODE`, e rode:

```powershell
npm run seed:cloud -w @minions/api
```

Isso cria as tabelas, os usuários/pessoas/propostas fictícios e indexa os 11 documentos com embeddings do Gemini.

Gerar segredos fortes:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## 4. Vercel — publicar (5 min)

1. Em https://vercel.com/new importe o repositório `GiovannyLino/minions`.
2. **Root Directory:** `apps/web` (o resto vem de [`apps/web/vercel.json`](../apps/web/vercel.json): instalação na raiz do monorepo, região `gru1`, rotina diária).
3. **Environment Variables** — as mesmas do `.env.cloud`, **menos** `NODE_ENV` e `VERCEL` (a Vercel define sozinha):

| Variável | Valor |
|---|---|
| `AUTH_MODE` | `dev` |
| `AUTH_SECRET` | segredo gerado (≥ 32 caracteres) |
| `DEMO_ACCESS_CODE` | código que você vai passar às pessoas (≥ 12 caracteres) |
| `ALLOW_REAL_DATA` | `false` |
| `DATABASE_URL` | URL *pooled* do Neon |
| `PG_POOL_MAX` | `3` |
| `STORAGE_PROVIDER` | `db` |
| `LLM_PROVIDER` / `GEMINI_API_KEY` / `GEMINI_MODEL` | `gemini` / sua chave / `gemini-3.5-flash-lite` |
| `EMBEDDING_PROVIDER` / `EMBEDDING_DIM` | `gemini` / `768` |
| `CRON_SECRET` | outro segredo gerado (a Vercel o envia à rotina diária) |
| `SESSION_COOKIE_SECURE` | `true` |

4. **Deploy.** O link `https://<projeto>.vercel.app` é fixo; cada `git push` na `main` publica uma nova versão.
5. Em **Settings → Deployment Protection**, mantenha *Vercel Authentication* nos **previews** (só a produção fica pública, atrás do código).

## Como funciona sem servidor

- **API embutida** ([apps/web/lib/embedded.ts](../apps/web/lib/embedded.ts)): o mesmo app Hono de `apps/api` roda dentro da função do Next. O BFF chama a API em processo, sem HTTP — mas cada chamada continua passando por autenticação Bearer, ACL, rate limit e auditoria.
- **Indexação:** não há worker permanente; após cada upload a fila é processada logo depois da resposta (`after()`), e a rotina diária (`/api/cron`, protegida por `CRON_SECRET`) recolhe o que sobrar e aplica a retenção (LGPD).
- **Arquivos:** guardados no Postgres (`file_blobs`), não na Vercel. Limite de upload de **4 MB** (teto da Vercel para o corpo da requisição).
- **Migrações:** aplicadas na primeira requisição, com *advisory lock* — várias instâncias subindo juntas não conflitam.

## Desenvolvimento local continua igual

`npm run dev` (API separada + Ollama/PGlite) segue funcionando. Para usar o Gemini localmente, basta `LLM_PROVIDER=gemini` e `GEMINI_API_KEY` no `.env` (trocar os embeddings para Gemini exige `EMBEDDING_DIM=768` e recriar a base com `npm run seed -w @minions/api -- --force`).

## Limitações honestas

- Primeira pergunta após um tempo parado leva alguns segundos a mais (função e banco "acordando").
- O limite gratuito do Gemini é por projeto e por dia; esgotado, as respostas ficam no modo extrativo até o dia seguinte. A memória de respostas reduz chamadas repetidas.
- Hobby da Vercel é para uso não comercial; para a empresa usar de fato, Vercel Pro (ou a arquitetura híbrida de [HOSTING.md](HOSTING.md)) e um provedor de IA com contrato (ex.: Gemini pago, que não usa o conteúdo).
