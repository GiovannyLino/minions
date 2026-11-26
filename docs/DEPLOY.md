# Minions — Publicação

> **Nenhum deploy foi realizado.** Este procedimento só deve ser executado após a aprovação do ambiente (ver [SECURITY.md](SECURITY.md) §6). Previews públicos devem usar apenas dados fictícios.

## 1. Pré-requisitos e aprovações

| Item | Responsável | Status |
|---|---|---|
| Assinatura Azure (homologação e produção separadas) em Brazil South | TI / Cloud | pendente |
| App registration no Entra ID (API + web), app roles `Minions.Admin` e `Minions.Manager`, claim de grupos | TI / Identidade | pendente |
| Contrato do provedor de IA revisado (retenção, ZDR, região) | Jurídico / DPO | pendente |
| Provedor de embeddings (Gemini pago ou Ollama na rede interna) | TI | pendente |
| RIPD / LGPD | DPO | pendente |
| Time da Vercel (Pro/Enterprise) e domínio | TI | pendente |

## 2. Backend (Azure)

1. **Banco:** Azure Database for PostgreSQL Flexible Server (PG 16+), acesso privado por VNet, extensões `vector` e `unaccent` habilitadas (`azure.extensions`). Backups automáticos + retenção definida.
2. **Armazenamento:** Storage Account com container privado, private endpoint, Defender for Storage. Implementar `AzureBlobStorageProvider` (interface `StorageProvider`, ~40 linhas).
3. **API e worker:** duas Container Apps a partir do mesmo código:
   - API: `npm run start -w @minions/api` (porta `API_PORT`), `EMBEDDED_WORKER=false`.
   - Worker: `npm run worker -w @minions/api`.
   - Com Postgres real, worker e API podem escalar de forma independente (fila com `SKIP LOCKED`).
4. **Segredos:** Key Vault referenciado pelas Container Apps (Managed Identity). Nada em arquivo.
5. **Entrada:** Front Door + WAF; restringir a origem ao BFF da Vercel (Secure Compute/IPs) e exigir token.

Variáveis da API (produção):

```
NODE_ENV=production
ALLOW_REAL_DATA=true            # só após o checklist
AUTH_MODE=oidc
OIDC_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0
OIDC_AUDIENCE=api://minions-api
OIDC_JWKS_URI=https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys
AUTH_SECRET=<Key Vault>         # links assinados
DATABASE_URL=<Key Vault>
LLM_PROVIDER=ollama            # none (grátis) | ollama (grátis, modelo local) | anthropic (pago)
OLLAMA_URL=http://<vm-ollama>:11434   # rede privada; nunca exposto à internet
EMBEDDING_PROVIDER=ollama      # ollama (grátis, rede interna) | gemini (exige GEMINI_PAID_TIER=true com dados reais)
EMBEDDING_MODEL=bge-m3
EMBEDDING_DIM=1024              # deve casar com o modelo de embeddings
MALWARE_SCANNER=clamav
TRUST_PROXY=true
WEB_ORIGIN=https://minions.<empresa>.com.br
```

> Trocar `EMBEDDING_DIM` exige reindexação: a API recusa iniciar se a coluna `chunks.embedding` tiver outra dimensão.

## 3. Frontend (Vercel)

1. Importar o repositório; *Root Directory* `apps/web`; comando de instalação `npm install` na raiz do monorepo.
2. `vercel.json` em `apps/web` com `"regions": ["gru1"]`.
3. Variáveis: `API_URL` (URL do Front Door), `SESSION_COOKIE_SECURE=true`. **Nenhuma** chave de IA, banco ou storage.
4. Variáveis OIDC do web (ver §4): `APP_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (variável criptografada da Vercel), `OIDC_API_SCOPE`.
5. Proteger previews (Vercel Authentication) e apontá-los para a API de homologação com dados fictícios.

## 4. Entra ID (login corporativo)

**Implementado:** fluxo Authorization Code + PKCE (S256) + `state` + `nonce` com cliente confidencial ([apps/web/app/auth](../apps/web/app/auth)), validação do access token na API (assinatura JWKS, emissor, audiência, expiração, escopo `scp`), provisionamento automático do usuário com papel vindo das *app roles* e grupos mapeados, logout com encerramento da sessão no Entra.

Testado localmente com o IdP de desenvolvimento (`npm run dev:sso`), que emite tokens no formato do Entra. **Ainda não testado contra um tenant real.**

### Registro dos aplicativos (portal do Entra)

1. **App "Minions API"**
   - *Expose an API*: App ID URI `api://minions-api`, escopo `access_as_user` (admins e usuários podem consentir).
   - *App roles*: `Minions.Admin` e `Minions.Manager` (tipo *Users/Groups*). Sem role = colaborador.
   - *Token configuration*: claim `groups` → **Groups assigned to the application** (evita o excesso de >200 grupos).
   - Manifesto: `"requestedAccessTokenVersion": 2`.
2. **App "Minions Web"**
   - Plataforma *Web*, redirect URI `https://<domínio>/auth/callback` (e `http://localhost:3000/auth/callback` só no tenant de teste).
   - *Front-channel logout URL* opcional: `https://<domínio>/login`.
   - *Certificates & secrets*: segredo do cliente (rotacionar; preferir certificado em produção).
   - *API permissions*: `Minions API / access_as_user` com consentimento do administrador.
3. **Enterprise app "Minions API"**: atribuir usuários/grupos às app roles. *Atribuição por grupo exige Entra ID P1/P2* (incluído em vários planos Microsoft 365); no plano Free, atribua usuários individualmente.

### Variáveis

API:

```
AUTH_MODE=oidc
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_AUDIENCE=<client-id-da-API>,api://minions-api
OIDC_JWKS_URI=https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys
OIDC_REQUIRED_SCOPE=access_as_user
OIDC_GROUP_MAP={"<objectId-grupo-comercial>":"comercial","<objectId-grupo-engenharia>":"engenharia"}
```

Web (`apps/web/.env.local` ou variáveis da Vercel):

```
APP_URL=https://<domínio>
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<client-id-do-web>
OIDC_CLIENT_SECRET=<segredo>
OIDC_API_SCOPE=api://minions-api/access_as_user
SESSION_COOKIE_SECURE=true
```

### Comportamento

- Sessão = access token da API em cookie `httpOnly`, `SameSite=Lax`, `Secure`; nunca exposto ao JavaScript. Dura o mesmo que o token (≈60–90 min); ao expirar, o usuário clica em entrar e o SSO do Entra renova sem pedir senha. Nenhum refresh token é armazenado.
- Papel e grupos são atualizados a cada requisição a partir do token; a habilitação (classificação máxima) é definida pelo admin no Minions e preservada.
- Uma conta existente com o mesmo e-mail **não** é vinculada automaticamente (evita sequestro de conta); o admin resolve o caso.
- Usuários com mais grupos que o limite do token ficam sem grupos (menor privilégio) e geram o alerta `oidc_groups_overage`.

## 5. Verificação pós-deploy

- `GET /health` da API; login via Entra; pergunta de teste com documento fictício de homologação.
- Teste de isolamento: usuário sem grupo não vê documento restrito (repetir os casos de `apps/api/test/system.test.ts`).
- Auditoria registrando `chat.ask` e `document.download`.
- Alertas: erros 5xx, fila de ingestão parada, falhas do provedor de IA.
