// Suporte a hospedagem serverless (Vercel): arquivos no próprio banco e limite de requisições compartilhado.
export default /* sql */ `
create table if not exists file_blobs (
  key text primary key,
  data bytea not null,
  size integer not null,
  created_at timestamptz not null default now()
);

create table if not exists rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits integer not null
);
create index if not exists rate_limits_window_idx on rate_limits (window_start);
`;
