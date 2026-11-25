-- Memória de respostas: reaproveita respostas já geradas para perguntas semelhantes,
-- sem chamar o modelo de IA (funciona offline). Revalidada contra versões e permissões a cada uso.

create table answer_memory (
  id uuid primary key,
  owner_id uuid not null references users(id) on delete cascade,
  question text not null,
  question_embedding vector({{EMBEDDING_DIM}}) not null,
  answer jsonb not null,
  source_versions uuid[] not null,
  -- A pergunta não dependia do contexto da conversa (pode ser compartilhada no escopo "organization").
  standalone boolean not null,
  hits integer not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index answer_memory_owner_idx on answer_memory (owner_id);
create index answer_memory_embedding_idx on answer_memory using hnsw (question_embedding vector_cosine_ops);
