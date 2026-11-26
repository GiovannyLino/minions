# Minions — Segurança e privacidade

Segurança é parte da arquitetura, não uma etapa posterior. Este documento lista o modelo de ameaças, os controles **já implementados** no MVP e o que ainda depende de configuração externa.

## 1. Classificação de dados

| Nível | Código | Exemplos | Quem acessa (padrão) |
|---|---|---|---|
| Público interno | `public` | Comunicados gerais | Todos os autenticados |
| Interno | `internal` | Procedimentos, manuais | Todos os autenticados |
| Restrito | `restricted` | Propostas, planilhas comerciais | Habilitação ≥ restrito **e** grupo/área permitidos |
| Confidencial | `confidential` | Contratos, dados pessoais (LGPD) | Habilitação confidencial **e** grupo/área permitidos |

Cada usuário tem `clearance` (nível máximo) e `groups` (áreas/equipes). Cada documento tem `classification` e `allowed_groups` (vazio = qualquer grupo dentro da habilitação).

## 2. Controle de acesso (RBAC + ACL)

| Perfil | Pode |
|---|---|
| `admin` | Tudo, inclusive usuários, permissões, logs, configurações dos agentes, exclusão definitiva |
| `manager` (gestor da base) | Enviar/atualizar/arquivar documentos da sua área, gerir propostas e pessoas, ver erros de ingestão |
| `collaborator` | Consultar o chat, ver documentos/propostas/pessoas autorizados |

- A política fica em um único módulo (`packages/core/src/auth/policy.ts`): matriz de ações por perfil + `documentAccessSql()`.
- **A autorização é aplicada no SQL de recuperação** (busca vetorial, full-text, listagem, download). Os agentes recebem um `Principal` e só conseguem consultar através de serviços que aplicam essa cláusula — não existe caminho do agente para o banco sem filtro.
- O download revalida a ACL mesmo com link assinado válido.
- Conversas pertencem ao usuário; toda leitura verifica `owner_id`. Memo de resultados é chaveado por usuário + conversa: respostas nunca são reaproveitadas entre usuários.
- O admin tem `clearance=confidential` e acesso a todos os grupos; gestores e colaboradores dependem de habilitação + grupo. Toda ação administrativa é auditada.

## 3. Modelo de ameaças e controles

| Risco | Controle implementado | Pendente / produção |
|---|---|---|
| Acesso não autorizado | JWT obrigatório em `/v1/*`; RBAC; ACL em SQL; testes de isolamento; OIDC com PKCE + state + nonce; access token validado (JWKS, emissor, audiência, `scp`, sem HS256/`none`); sem vínculo de conta por e-mail | Registrar apps no Entra; Conditional Access/MFA |
| Vazamento de documentos | Arquivos fora do diretório público, chave aleatória, sem URL direta; links HMAC de 5 min; ACL revalidada | Blob privado com private endpoint, CMK |
| Exposição em logs | `pino` com redação (`authorization`, `cookie`, `password`, `token`, conteúdo de perguntas truncado); auditoria grava metadados, não conteúdo de documentos | Log Analytics com retenção definida |
| Prompt injection em documentos | Documentos tratados como dados: trechos envoltos em `<document>` com instrução explícita; detector heurístico marca trechos suspeitos (sinalizados na UI/admin); permissões vivem em código, nunca no prompt; o LLM não tem ferramentas com efeitos colaterais | Classificador dedicado, revisão humana de trechos sinalizados |
| Arquivos maliciosos | Lista de extensões permitidas, *magic bytes* vs extensão, limite de tamanho, inspeção de ZIP (DOCX/XLSX: zip bomb, macros `vbaProject.bin`, entradas externas), PDF com `/JavaScript`/`/Launch` rejeitado, interface de antivírus (ClamAV `INSTREAM`) | Habilitar ClamAV ou Microsoft Defender for Storage |
| URLs de armazenamento expostas | Nunca retornadas; somente tokens assinados opacos | — |
| Respostas compartilhadas indevidamente | Conversas por dono; memória de respostas por usuário por padrão; no escopo `organization`, só perguntas sem contexto e com ACL/versões revalidadas a cada uso; nunca expõe a pergunta original | Avaliar com o DPO antes de ativar `organization` com dados reais (a resposta pode refletir termos digitados por outra pessoa) |
| Uso indevido de credenciais | Segredos apenas em variáveis de ambiente validadas; `.env` no `.gitignore`; nada no frontend além de `API_URL` server-side | Key Vault / Vercel env encrypted; rotação |
| Ataques web comuns | Headers seguros (CSP, HSTS, X-Frame-Options), CORS restrito, cookie `httpOnly`+`SameSite=Lax`+`Secure` em prod, validação zod de entrada, limite de corpo, SQL parametrizado, rate limit por usuário | WAF (Front Door / Vercel Firewall) |
| Força bruta / abuso | Rate limit (token bucket) por usuário e por IP no login de dev | Redis compartilhado em multi-instância |
| Ciclos/custos de IA | Orçamento por requisição (chamadas de agente/LLM, profundidade, prazo) | Orçamento mensal por provedor |
| Indexação em ambiente inadequado | `ALLOW_REAL_DATA=false` por padrão; banner "dados fictícios"; dev login bloqueado em `NODE_ENV=production`, exceto na demonstração com `DEMO_ACCESS_CODE` (≥ 12 caracteres) e `ALLOW_REAL_DATA=false` | Checklist de aprovação (§6) |

## 4. LGPD

- **Base legal e finalidade:** documentar no RIPD (Relatório de Impacto) antes de dados reais.
- **Minimização:** contatos exibem apenas dados corporativos autorizados (`contact_visibility`); nada de CPF, telefone pessoal etc.
- **Direitos do titular:** exclusão definitiva (admin) remove arquivo, versões, trechos e embeddings; conversas podem ser apagadas pelo dono.
- **Retenção:** `RETENTION_CONVERSATION_DAYS` e `RETENTION_AUDIT_DAYS` (job de limpeza `purgeExpired`).
- **Transferência internacional:** provedores de IA processam fora do Brasil por padrão — ver [HOSTING.md](HOSTING.md) §4.

## 5. Provedores de IA

- *Alternativas futuras (não implementadas; exigem orçamento):* Anthropic (API comercial): por padrão mantém entradas/saídas por **30 dias**; ZDR (zero data retention) só mediante acordo, com exceções (Files API, cache de schema de saídas estruturadas por até 24 h, conteúdo sinalizado). Os modelos Fable/Mythos exigem retenção de 30 dias; **o padrão do Minions é `claude-opus-5-5`**, elegível a ZDR. Fontes: [API and data retention](https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention), [ZDR FAQ](https://privacy.claude.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to).
- Alternativa com contrato Microsoft: Claude via Microsoft Foundry (cobrança e termos Azure).
- **Opção sem custo e sem terceiros:** `LLM_PROVIDER=ollama` — o modelo roda na infraestrutura da empresa e nenhum trecho sai da rede. É o modo recomendado para o protótipo.
- **Google Gemini (plano gratuito)** — usado na demonstração em nuvem ([VERCEL.md](VERCEL.md)). No plano gratuito o Google pode usar o conteúdo enviado para melhorar os produtos dele; no plano pago, não. Por isso `ALLOW_REAL_DATA=true` com Gemini é recusado na inicialização sem `GEMINI_PAID_TIER=true`. A chave vai só no header `x-goog-api-key` (nunca na URL). Fonte: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing).
- O Minions **não usa** Files API nem armazenamento de sessão no provedor; envia apenas os trechos já autorizados para o usuário.

## 6. Checklist antes de dados reais

1. Ambiente aprovado (homologação/produção isolados, região Brasil).
2. Entra ID configurado (`AUTH_MODE=oidc`), dev login desabilitado.
3. Banco gerenciado com criptografia em repouso, backups, private endpoint.
4. Blob privado + antivírus habilitado (`MALWARE_SCANNER=clamav`).
5. Contrato/termos do provedor de IA revisados (retenção, ZDR, região).
6. RIPD/LGPD aprovado pelo DPO; classificação dos documentos definida pela área dona.
7. Pentest e revisão dos testes de isolamento.
8. `ALLOW_REAL_DATA=true` somente após 1–7.
