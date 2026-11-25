# Minions — Avaliação de hospedagem

Pergunta: dá para usar a Vercel sem colocar documentos corporativos em ambiente inadequado? **Sim — com a arquitetura híbrida (Opção C).** A Vercel hospeda apenas a interface e o BFF (proxy sem estado); documentos, embeddings, banco, fila e agentes ficam em nuvem corporativa na região Brasil.

## 1. Fatos verificados (nov/2026)

- Vercel Functions rodam por padrão em `iad1` (Washington); é preciso fixar `gru1` (São Paulo, AWS `sa-east-1`) em `vercel.json`. Rede privada dedicada (Secure Compute) é recurso Enterprise. — [Vercel regions](https://vercel.com/docs/regions), [Function regions](https://vercel.com/docs/functions/regions)
- Azure Database for PostgreSQL Flexible Server: disponível em Brazil South, suporta `pgvector` e acesso privado por VNet. — [Visão geral](https://learn.microsoft.com/en-us/azure/postgresql/overview)
- Teams: o Microsoft 365 Agents SDK / Teams SDK substituem o Bot Framework SDK; o bot recebe atividades e repassa à mesma API. — [Agents SDK](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/agents-sdk-overview), [migração](https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/bf-migration-nodejs)
- Anthropic API: retenção padrão de 30 dias; ZDR sob acordo. — [API and data retention](https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention)

## 2. Comparação

| Critério | A — Tudo na Vercel | B — Nuvem corporativa (Azure) | C — Híbrida (recomendada) |
|---|---|---|---|
| Segurança dos documentos | Arquivos e banco em serviços de marketplace; difícil isolar rede sem Enterprise | Alta: VNet, private endpoints, Key Vault, Defender | Alta: documentos nunca passam pela Vercel em repouso; só trafegam respostas já autorizadas |
| LGPD / região | Possível fixar `gru1` para funções, mas banco/blob dependem do provedor do marketplace | Brazil South em todos os componentes | Dados em Brazil South; BFF em `gru1` |
| Autenticação corporativa | Entra ID via OIDC no app | Entra ID nativo, Managed Identity | Entra ID no web (OIDC) + validação JWT na API |
| Isolamento de rede | Limitado sem Secure Compute | Total | API exposta só via Front Door/WAF com allowlist + token; ou Secure Compute |
| Manutenção | Muito simples | Maior (IaC, Container Apps) | Média |
| Custo | Baixo no início, cresce com uso de funções longas (SSE) | Previsível, reservas | Vercel Pro + Azure básico |
| Escalabilidade | Boa para UI; workers de ingestão ruins em serverless | Boa (Container Apps + fila) | Boa |
| Teams | Possível, mas bot precisa de endpoint estável | Natural (Azure Bot Service) | Natural: bot no Azure chama a API |
| Processos longos (ingestão, chat SSE) | Limites de duração de função | Sem limite prático | Executados no Azure |

## 3. Recomendação: Opção C

```
Usuário ──HTTPS──▶ Vercel (gru1): Next.js UI + BFF /api/* (sem dados em repouso)
                     │  Authorization: Bearer <token Entra ID>
                     ▼
            Azure Front Door + WAF (allowlist de origem Vercel / Secure Compute)
                     ▼
     Azure Container Apps (Brazil South, VNet): apps/api  +  apps/api worker
          │ private endpoint                 │ private endpoint
          ▼                                  ▼
   PostgreSQL Flexible (pgvector)       Blob Storage privado (Defender for Storage)
          Key Vault (segredos)  ·  Log Analytics (logs redigidos)  ·  Azure Bot (Teams)
```

Variáveis na Vercel: apenas `API_URL`, `SESSION_SECRET`, configuração OIDC do Entra. **Nenhuma** chave de IA, banco ou storage.

Se a política corporativa proibir qualquer tráfego de conteúdo por terceiros, use a **Opção B** (Next.js também em Container Apps/App Service) — o código já suporta, pois o web é um app Next padrão.

## 4. Provedor de IA

| Opção | Prós | Contras |
|---|---|---|
| **Ollama local/self-hosted (grátis)** — recomendado para o protótipo | Sem custo por uso; documentos nunca saem da rede; sem contrato de terceiros | Qualidade inferior a modelos de ponta; exige CPU/GPU e RAM (≈8 GB para 7B) |
| Anthropic API direta | Recursos mais novos primeiro | 30 dias de retenção (ZDR sob acordo); processamento fora do Brasil |
| Claude via Microsoft Foundry | Contrato e cobrança Azure, Entra ID | Verificar região de processamento e paridade de recursos |
| Claude via Amazon Bedrock | Contrato AWS | Infra diferente do restante |

Trocar de provedor = trocar a implementação de `LlmProvider` (`packages/core/src/ai`). Embeddings: Voyage AI ou Azure OpenAI (implementação OpenAI-compatível incluída).

## 5. Ambientes

| Ambiente | Dados | Auth | Onde |
|---|---|---|---|
| dev | Fictícios (`seed/`) | `AUTH_MODE=dev` (seleção de usuário fictício) | Local, PGlite |
| preview (Vercel) | **Somente fictícios**, API de homologação | dev ou Entra de teste | Vercel preview + API homolog |
| homologação | Fictícios ou amostra aprovada | Entra ID (tenant de teste) | Azure, assinatura separada |
| produção | Reais, após checklist de [SECURITY.md](SECURITY.md) §6 | Entra ID | Azure + Vercel produção |

**Fase de protótipo (custo zero):** o Minions é publicado a partir do PC do responsável via Cloudflare Tunnel (`npm run share`), com código de acesso obrigatório e apenas dados fictícios. A Vercel não comporta o sistema completo sem backend externo (não roda Ollama, banco local nem worker) e o plano Hobby é para uso não comercial; ela volta a fazer sentido na Opção C, com backend corporativo.

Nenhum deploy em nuvem foi feito. O procedimento está em [DEPLOY.md](DEPLOY.md).
