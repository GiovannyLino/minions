# Minions — Preparação para Microsoft Teams

O núcleo (`@minions/core`) não depende de interface. A web é apenas um cliente da API; o Teams será outro.

## O que já está pronto

| Requisito | Como |
|---|---|
| Mesma API | `POST /v1/chat` (SSE) e `GET /v1/conversations/*` servem qualquer cliente autenticado |
| Mesmos agentes | `Orchestrator.ask()` recebe `Principal` + pergunta e devolve `ChatAnswer` estruturado — sem HTML |
| Permissões preservadas | A API aceita tokens do Entra ID (`AUTH_MODE=oidc`), provisiona o usuário e aplica a mesma ACL |
| Orquestração independente | Nenhuma regra de negócio na web; o bot reutiliza o contrato `ChatAnswer` |
| Autenticação corporativa | SSO do Teams → token on-behalf-of para `api://minions-api` |

## Caminho sugerido

1. **Bot** com Microsoft 365 Agents SDK (Node) em Azure Container Apps + Azure Bot Service.
2. No recebimento de uma mensagem: obter o token do usuário (SSO/OBO), chamar `POST /v1/chat` e consumir o stream.
3. Renderizar `ChatAnswer` como **Adaptive Card**: resumo, passos (`FactSet`/lista), fontes como `Action.OpenUrl` para `GET /v1/documents/:id/download-link` (gerado por usuário), pessoas com `mailto:`/chat do Teams, sugestões como `Action.Submit`.
4. Opcional: aba pessoal apontando para a web (incluir `teams.microsoft.com` e domínios do Teams em `frame-ancestors` da CSP em `apps/web/next.config.ts`).

Nada do núcleo precisa mudar para isso.
