import { rmSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MIGRATIONS } from './migrations/index';

/** Interface mínima de acesso a dados — implementada por node-postgres (produção) e PGlite (dev/testes). */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Cópia de segurança consistente (somente PGlite; Postgres usa os backups do provedor). */
  backup?(): Promise<string | null>;
  close(): Promise<void>;
}

export interface DbOptions {
  /** postgres://... — se ausente usa PGlite */
  databaseUrl?: string;
  /** Diretório de dados do PGlite; `memory://` para testes */
  dataDir?: string;
  /** Tamanho máximo do pool do Postgres. */
  poolMax?: number;
}

export async function createDb(opts: DbOptions): Promise<Db> {
  if (opts.databaseUrl) return createPgDb(opts.databaseUrl, opts.poolMax);
  return createPgliteDb(opts.dataDir ?? 'memory://');
}

async function createPgDb(url: string, max = 10): Promise<Db> {
  const pg = await import('pg');
  const Pool = pg.default?.Pool ?? (pg as unknown as { Pool: typeof import('pg').Pool }).Pool;
  const pool = new Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
  // Conexões ociosas derrubadas pelo provedor (ex.: Neon ao hibernar) não podem derrubar o processo.
  pool.on('error', () => undefined);
  const run = async <T>(client: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }, sql: string, params?: unknown[]) =>
    (await client.query(sql, params)).rows as T[];
  return {
    kind: 'pg',
    query: (sql, params) => run(pool, sql, params),
    one: async (sql, params) => (await run(pool, sql, params))[0] as never,
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn({ query: (sql, params) => run(client, sql, params) });
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Erro amigável: o banco local já está aberto por outra instância do Minions. */
export class DatabaseInUseError extends Error {
  constructor(public readonly pid: number) {
    super(
      `O banco local já está em uso por outra instância do Minions (processo ${pid}). ` +
        'Feche-a antes (Ctrl+C no terminal onde rodou "npm run dev") — dois processos no mesmo banco o corrompem.',
    );
    this.name = 'DatabaseInUseError';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Lança DatabaseInUseError se outro processo estiver usando o banco local (ex.: antes de recriá-lo). */
export async function assertDatabaseFree(dataDir: string): Promise<void> {
  const pid = Number.parseInt(await readFile(`${dataDir}.lock`, 'utf8').catch(() => ''), 10);
  if (Number.isFinite(pid) && pid !== process.pid && pidAlive(pid)) throw new DatabaseInUseError(pid);
}

/** Trava de instância única: o PGlite não protege o diretório contra dois processos simultâneos. */
async function acquireLock(lockPath: string): Promise<() => void> {
  try {
    const pid = Number.parseInt(await readFile(lockPath, 'utf8'), 10);
    if (Number.isFinite(pid) && pid !== process.pid && pidAlive(pid)) throw new DatabaseInUseError(pid);
  } catch (err) {
    if (err instanceof DatabaseInUseError) throw err;
  }
  await writeFile(lockPath, String(process.pid));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* ignora */
    }
  };
  process.once('exit', release);
  return release;
}

const BACKUP_KEEP = 3;
const backupDirOf = (dataDir: string) => path.join(path.dirname(dataDir), 'backups');

async function latestBackup(dataDir: string): Promise<string | null> {
  const dir = backupDirOf(dataDir);
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith('pglite-') && f.endsWith('.tar.gz')).sort();
  return files.length ? path.join(dir, files[files.length - 1]!) : null;
}

async function createPgliteDb(dataDir: string, log: (msg: string) => void = (m) => console.warn(m)): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { unaccent } = await import('@electric-sql/pglite/contrib/unaccent');
  const extensions = { vector, unaccent };
  const inMemory = dataDir.startsWith('memory://');
  let release = () => {};
  if (!inMemory) {
    await mkdir(dataDir, { recursive: true });
    release = await acquireLock(`${dataDir}.lock`);
  }

  let db: InstanceType<typeof PGlite>;
  try {
    db = await PGlite.create({ dataDir, extensions });
  } catch (err) {
    if (inMemory) throw err;
    // Autorrecuperação: preserva o diretório danificado e restaura o último backup válido.
    const backup = await latestBackup(dataDir);
    if (!backup) {
      release();
      throw new Error(
        'O banco local está danificado e não há backup para restaurar. Recrie a base de demonstração com: npm run seed -w @minions/api -- --force',
        { cause: err },
      );
    }
    const broken = `${dataDir}-danificado-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await rename(dataDir, broken);
    log(`[minions] Banco local danificado. Diretório preservado em ${broken}; restaurando ${path.basename(backup)}…`);
    db = await PGlite.create({ dataDir, extensions, loadDataDir: new Blob([await readFile(backup)]) });
  }

  const backupNow = async (): Promise<string | null> => {
    if (inMemory) return null;
    const dir = backupDirOf(dataDir);
    await mkdir(dir, { recursive: true });
    const file = await db.dumpDataDir('gzip');
    const target = path.join(dir, `pglite-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
    await writeFile(`${target}.tmp`, Buffer.from(await file.arrayBuffer()));
    await rename(`${target}.tmp`, target);
    const all = (await readdir(dir)).filter((f) => f.startsWith('pglite-') && f.endsWith('.tar.gz')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) await rm(path.join(dir, old), { force: true });
    return target;
  };

  return {
    kind: 'pglite',
    query: async (sql, params) => (await db.query(sql, params)).rows as never,
    one: async (sql, params) => (await db.query(sql, params)).rows[0] as never,
    transaction: (fn) => db.transaction((tx) => fn({ query: async (sql, params) => (await tx.query(sql, params)).rows as never })),
    backup: backupNow,
    async close() {
      try {
        if (!inMemory) await backupNow().catch(() => null);
        await db.close();
      } finally {
        release();
      }
    },
  };
}

/** Chave arbitrária do advisory lock que serializa migrações entre instâncias (ex.: várias funções na Vercel). */
const MIGRATION_LOCK = 72_620_251;

/** Aplica migrações SQL em ordem, uma única vez cada — seguro com várias instâncias subindo ao mesmo tempo. */
export async function migrate(db: Db, opts: { embeddingDim: number }): Promise<string[]> {
  const lock = async (tx: Queryable) => {
    if (db.kind === 'pg') await tx.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
  };
  const pendingNames = async () => {
    const exists = await db.one<{ ok: boolean }>(`select to_regclass('schema_migrations') is not null as ok`);
    if (!exists?.ok) return MIGRATIONS.map((m) => m.name);
    const applied = new Set((await db.query<{ name: string }>('select name from schema_migrations')).map((r) => r.name));
    return MIGRATIONS.filter((m) => !applied.has(m.name)).map((m) => m.name);
  };
  // Caminho rápido (a cada partida a frio): nada pendente, nenhum lock.
  const newlyApplied: string[] = [];
  if ((await pendingNames()).length) {
    for (const migration of MIGRATIONS) {
      const sql = migration.sql.replaceAll('{{EMBEDDING_DIM}}', String(opts.embeddingDim));
      await db.transaction(async (tx) => {
        await lock(tx);
        await tx.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
        const done = await tx.query('select 1 from schema_migrations where name = $1', [migration.name]);
        if (done.length) return;
        for (const statement of splitSql(sql)) await tx.query(statement);
        await tx.query('insert into schema_migrations (name) values ($1)', [migration.name]);
        newlyApplied.push(migration.name);
      });
    }
  }
  await assertEmbeddingDim(db, opts.embeddingDim);
  return newlyApplied;
}

/** Garante que a dimensão configurada corresponde à coluna existente (trocar de provedor exige reindexação). */
async function assertEmbeddingDim(db: Db, expected: number) {
  const row = await db.one<{ typmod: number }>(
    `select atttypmod as typmod from pg_attribute where attrelid = 'chunks'::regclass and attname = 'embedding'`,
  );
  if (row && row.typmod > 0 && row.typmod !== expected) {
    throw new Error(
      `EMBEDDING_DIM=${expected} difere da coluna chunks.embedding (${row.typmod}). Recrie o índice com uma migração de reindexação.`,
    );
  }
}

function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Converte um vetor para o literal aceito pelo pgvector. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',')}]`;
}

export const iso = (d: unknown): string => (d instanceof Date ? d.toISOString() : d == null ? '' : new Date(String(d)).toISOString());
export const isoOrNull = (d: unknown): string | null => (d == null ? null : iso(d));
