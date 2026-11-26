import path from 'node:path';
import type { AgentSettings } from './contracts';
import { CategoryService, DashboardService, SettingsService } from './admin/admin';
import { SessionResultCache } from './agents/bus';
import { AnswerMemoryService } from './agents/memory';
import { Orchestrator } from './agents/orchestrator';
import { AuditService } from './audit/audit';
import { UserService } from './auth/users';
import { createOidcVerifier } from './auth/tokens';
import { HashingEmbeddingProvider, OpenAICompatibleEmbeddingProvider, VoyageEmbeddingProvider, type EmbeddingProvider } from './ai/embeddings';
import { AnthropicLlmProvider, type LlmProvider } from './ai/llm';
import { GeminiEmbeddingProvider, GeminiLlmProvider } from './ai/gemini';
import { OllamaEmbeddingProvider, OllamaLlmProvider } from './ai/ollama';
import type { Env } from './config/env';
import { ConversationService } from './conversations/conversations';
import { createDb, migrate, type Db } from './db/client';
import { PeopleService } from './directory/people';
import { ProposalService } from './directory/proposals';
import { DocumentService } from './knowledge/documents';
import { ClamAvScanner, NoopScanner, type MalwareScanner } from './knowledge/fileSecurity';
import { createLogger, type Logger } from './logging/logger';
import { DbStorageProvider, LocalStorageProvider, type StorageProvider } from './storage/storage';

/**
 * Núcleo de inteligência do Minions, independente de interface. A API HTTP (web) e uma futura
 * integração com o Microsoft Teams instanciam este mesmo núcleo.
 */
export interface Minions {
  env: Env;
  db: Db;
  logger: Logger;
  audit: AuditService;
  users: UserService;
  documents: DocumentService;
  proposals: ProposalService;
  people: PeopleService;
  conversations: ConversationService;
  orchestrator: Orchestrator;
  memory: AnswerMemoryService;
  /** true quando nenhum componente depende de serviço externo (IA, embeddings e antivírus locais). */
  offline: boolean;
  settings: SettingsService;
  categories: CategoryService;
  dashboard: DashboardService;
  embeddings: EmbeddingProvider;
  llm: LlmProvider | null;
  oidcVerifier: ReturnType<typeof createOidcVerifier> | null;
  close(): Promise<void>;
}

export interface MinionsOverrides {
  db?: Db;
  storage?: StorageProvider;
  embeddings?: EmbeddingProvider;
  llm?: LlmProvider | null;
  scanner?: MalwareScanner;
  logger?: Logger;
}

export function defaultAgentSettings(env: Env): AgentSettings {
  return {
    enabledAgents: ['knowledge', 'process', 'proposal', 'people'],
    maxAgentCalls: env.AGENT_MAX_CALLS,
    maxDepth: env.AGENT_MAX_DEPTH,
    maxLlmCalls: env.AGENT_MAX_LLM_CALLS,
    timeoutMs: env.AGENT_TIMEOUT_MS,
    retrievalTopK: 8,
    minRelevance: 0.34,
    answerMemory: 'user',
    memorySimilarity: 0.92,
  };
}

function createEmbeddings(env: Env): EmbeddingProvider {
  switch (env.EMBEDDING_PROVIDER) {
    case 'voyage':
      return new VoyageEmbeddingProvider(env.EMBEDDING_API_KEY!, env.EMBEDDING_DIM, env.EMBEDDING_MODEL, env.EMBEDDING_BASE_URL);
    case 'gemini':
      return new GeminiEmbeddingProvider(env.EMBEDDING_DIM, {
        apiKey: (env.EMBEDDING_API_KEY ?? env.GEMINI_API_KEY)!,
        model: env.EMBEDDING_MODEL ?? 'gemini-embedding-001',
        baseUrl: env.EMBEDDING_BASE_URL,
      });
    case 'ollama':
      return new OllamaEmbeddingProvider(env.EMBEDDING_DIM, env.EMBEDDING_MODEL ?? 'nomic-embed-text', env.EMBEDDING_BASE_URL ?? env.OLLAMA_URL);
    case 'openai':
      return new OpenAICompatibleEmbeddingProvider(env.EMBEDDING_API_KEY!, env.EMBEDDING_DIM, env.EMBEDDING_MODEL, env.EMBEDDING_BASE_URL);
    default:
      return new HashingEmbeddingProvider(env.EMBEDDING_DIM);
  }
}

export async function createMinions(env: Env, overrides: MinionsOverrides = {}): Promise<Minions> {
  const logger = overrides.logger ?? createLogger();
  const db = overrides.db ?? (await createDb({ databaseUrl: env.DATABASE_URL, dataDir: path.resolve(env.DATA_DIR, 'pglite'), poolMax: env.PG_POOL_MAX }));
  const applied = await migrate(db, { embeddingDim: env.EMBEDDING_DIM });
  if (applied.length) logger.info({ applied }, 'migrations_applied');

  const storage = overrides.storage ?? (env.STORAGE_PROVIDER === 'db' ? new DbStorageProvider(db) : new LocalStorageProvider(path.resolve(env.DATA_DIR, 'storage')));
  const embeddings = overrides.embeddings ?? createEmbeddings(env);
  const llm =
    overrides.llm !== undefined
      ? overrides.llm
      : env.LLM_PROVIDER === 'anthropic'
        ? new AnthropicLlmProvider(env.LLM_MODEL, { apiKey: env.ANTHROPIC_API_KEY, refusalFallback: env.AI_REFUSAL_FALLBACK === 'default', logger })
        : env.LLM_PROVIDER === 'gemini'
          ? new GeminiLlmProvider(env.GEMINI_MODEL, { apiKey: env.GEMINI_API_KEY!, logger })
          : env.LLM_PROVIDER === 'ollama'
            ? new OllamaLlmProvider(env.OLLAMA_MODEL, { baseUrl: env.OLLAMA_URL, logger })
            : null;
  const scanner = overrides.scanner ?? (env.MALWARE_SCANNER === 'clamav' ? new ClamAvScanner(env.CLAMAV_HOST, env.CLAMAV_PORT) : new NoopScanner());

  const audit = new AuditService(db, logger);
  const settings = new SettingsService(db, defaultAgentSettings(env), audit);
  const people = new PeopleService(db, audit);
  const proposals = new ProposalService(db, audit);
  const documents = new DocumentService({ db, storage, scanner, embeddings, audit, logger, authSecret: env.AUTH_SECRET, maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024 });
  const memory = new AnswerMemoryService(db, people);
  const orchestrator = new Orchestrator({ db, embeddings, people, proposals, llm, memory, cache: new SessionResultCache(), settings: () => settings.agentSettings(), logger });

  return {
    env,
    db,
    logger,
    audit,
    users: new UserService(db),
    documents,
    proposals,
    people,
    conversations: new ConversationService(db),
    orchestrator,
    memory,
    offline: (env.LLM_PROVIDER === 'none' || env.LLM_PROVIDER === 'ollama') && (env.EMBEDDING_PROVIDER === 'hash' || env.EMBEDDING_PROVIDER === 'ollama'),
    settings,
    categories: new CategoryService(db, audit),
    dashboard: new DashboardService(db),
    embeddings,
    llm,
    oidcVerifier:
      env.AUTH_MODE === 'oidc'
        ? createOidcVerifier({
            issuer: env.OIDC_ISSUER!,
            audience: env.OIDC_AUDIENCE!,
            jwksUri: env.OIDC_JWKS_URI!,
            groupsClaim: env.OIDC_GROUPS_CLAIM,
            rolesClaim: env.OIDC_ROLES_CLAIM,
            requiredScope: env.OIDC_REQUIRED_SCOPE,
            groupMap: env.OIDC_GROUP_MAP,
          })
        : null,
    close: () => db.close(),
  };
}
