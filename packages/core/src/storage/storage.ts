import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Queryable } from '../db/client';
import path from 'node:path';

/**
 * Armazenamento privado de arquivos. Implementações futuras: Azure Blob (private endpoint),
 * S3 (bucket privado), SharePoint como fonte. Nunca expõe URL direta — downloads passam pela API.
 */
export interface StorageProvider {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/-]{0,200}$/;

export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    if (!KEY_PATTERN.test(key) || key.includes('..')) throw new Error('Chave de armazenamento inválida');
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Chave de armazenamento fora da raiz');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

export class MemoryStorageProvider implements StorageProvider {
  private readonly files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    const f = this.files.get(key);
    if (!f) throw new Error('Arquivo não encontrado');
    return f;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

/**
 * Arquivos guardados no próprio Postgres (tabela file_blobs). Usado em hospedagem serverless,
 * onde o disco é temporário: documentos ficam no banco (ex.: Neon em São Paulo), não na Vercel.
 * Adequado ao protótipo (uploads de até 4 MB); em produção prefira um blob privado (Azure/S3).
 */
export class DbStorageProvider implements StorageProvider {
  constructor(private readonly db: Queryable) {}

  private check(key: string) {
    if (!KEY_PATTERN.test(key) || key.includes('..')) throw new Error('Chave de armazenamento inválida');
  }

  async put(key: string, data: Buffer): Promise<void> {
    this.check(key);
    await this.db.query(
      'insert into file_blobs (key, data, size) values ($1, $2, $3) on conflict (key) do update set data = excluded.data, size = excluded.size',
      [key, data, data.length],
    );
  }

  async get(key: string): Promise<Buffer> {
    this.check(key);
    const rows = await this.db.query<{ data: Uint8Array }>('select data from file_blobs where key = $1', [key]);
    if (!rows[0]) throw new Error('Arquivo não encontrado');
    return Buffer.from(rows[0].data);
  }

  async delete(key: string): Promise<void> {
    this.check(key);
    await this.db.query('delete from file_blobs where key = $1', [key]);
  }
}
