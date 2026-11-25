-- Minions — esquema inicial
-- {{EMBEDDING_DIM}} é substituído pelo executor de migrações (EMBEDDING_DIM).

create extension if not exists vector;
create extension if not exists unaccent;

create table users (
  id uuid primary key,
  external_id text unique,
  email text not null unique,
  name text not null,
  role text not null check (role in ('admin', 'manager', 'collaborator')),
  area text,
  groups text[] not null default '{}',
  clearance text not null default 'internal' check (clearance in ('public', 'internal', 'restricted', 'confidential')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table categories (
  id uuid primary key,
  name text not null unique,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table people (
  id uuid primary key,
  name text not null,
  email text,
  job_title text,
  area text not null,
  expertise text[] not null default '{}',
  responsibilities text[] not null default '{}',
  contact_visible boolean not null default true,
  user_id uuid references users(id) on delete set null,
  search_tsv tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index people_tsv_idx on people using gin (search_tsv);
create index people_area_idx on people (area);

create table proposals (
  id uuid primary key,
  code text not null unique,
  name text not null,
  client text not null default '',
  description text not null default '',
  scope text not null default '',
  status text not null check (status in ('draft', 'in_review', 'submitted', 'won', 'lost', 'cancelled')),
  area text not null,
  classification text not null check (classification in ('public', 'internal', 'restricted', 'confidential')),
  owner_person_id uuid references people(id) on delete set null,
  due_date date,
  deliverables text[] not null default '{}',
  search_tsv tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index proposals_tsv_idx on proposals using gin (search_tsv);

create table proposal_members (
  proposal_id uuid not null references proposals(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  primary key (proposal_id, person_id)
);

create table proposal_history (
  id uuid primary key,
  proposal_id uuid not null references proposals(id) on delete cascade,
  at timestamptz not null default now(),
  by_user uuid references users(id) on delete set null,
  change text not null
);

create table documents (
  id uuid primary key,
  title text not null,
  description text not null default '',
  category text not null,
  area text not null,
  classification text not null check (classification in ('public', 'internal', 'restricted', 'confidential')),
  allowed_groups text[] not null default '{}',
  subject_key text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed', 'archived')),
  owner_id uuid not null references users(id),
  current_version_id uuid,
  proposal_id uuid references proposals(id) on delete set null,
  flags text[] not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_status_idx on documents (status);
create index documents_subject_idx on documents (subject_key);

create table document_versions (
  id uuid primary key,
  document_id uuid not null references documents(id) on delete cascade,
  version integer not null,
  file_name text not null,
  mime_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  storage_key text not null,
  page_count integer,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed', 'archived')),
  error text,
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (document_id, version)
);

alter table documents
  add constraint documents_current_version_fk foreign key (current_version_id) references document_versions(id) on delete set null;

create table chunks (
  id uuid primary key,
  document_id uuid not null references documents(id) on delete cascade,
  version_id uuid not null references document_versions(id) on delete cascade,
  ordinal integer not null,
  content text not null,
  page integer,
  section text,
  token_estimate integer not null,
  suspicious boolean not null default false,
  embedding vector({{EMBEDDING_DIM}}),
  tsv tsvector,
  created_at timestamptz not null default now()
);
create index chunks_version_idx on chunks (version_id);
create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);

create table ingestion_jobs (
  id uuid primary key,
  version_id uuid not null references document_versions(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  last_error text,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ingestion_jobs_pick_idx on ingestion_jobs (status, run_after);

create table conversations (
  id uuid primary key,
  owner_id uuid not null references users(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_owner_idx on conversations (owner_id, updated_at desc);

create table messages (
  id uuid primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  answer jsonb,
  trace jsonb,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on messages (conversation_id, created_at);

create table audit_log (
  id uuid primary key,
  at timestamptz not null default now(),
  actor_id uuid references users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  outcome text not null check (outcome in ('success', 'denied', 'error')),
  metadata jsonb not null default '{}',
  ip text
);
create index audit_log_at_idx on audit_log (at desc);
create index audit_log_action_idx on audit_log (action);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);
