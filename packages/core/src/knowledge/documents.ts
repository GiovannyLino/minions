import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CLASSIFICATION_RANK,
  DocumentMetadataInputSchema,
  type DocumentDTO,
  type DocumentMetadataInput,
  type DocumentStatus,
  type DocumentVersionDTO,
} from '../contracts';
import type { AuditService } from '../audit/audit';
import { assertCan, canManageDocument, canReadDocument, documentAccessSql, effectiveGroups, type Principal } from '../auth/policy';
import { signDownloadToken, verifyDownloadToken } from '../auth/tokens';
import { iso, toVectorLiteral, type Db } from '../db/client';
import { ConflictError, FileRejectedError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import type { EmbeddingProvider } from '../ai/embeddings';
import type { Logger } from '../logging/logger';
import type { StorageProvider } from '../storage/storage';
import { chunkSections } from './chunker';
import { extractContent } from './extractors';
import { validateFile, type MalwareScanner, type SupportedExt } from './fileSecurity';
import { scanForInjection } from './injection';

interface DocRow {
  id: string;
  title: string;
  description: string;
  category: string;
  area: string;
  classification: DocumentDTO['classification'];
  allowed_groups: string[];
  subject_key: string | null;
  status: DocumentStatus;
  owner_id: string;
  owner_name: string | null;
  current_version_id: string | null;
  proposal_id: string | null;
  flags: string[];
  error: string | null;
  created_at: Date;
  updated_at: Date;
  v_version: number | null;
  v_file_name: string | null;
  v_mime_type: string | null;
  v_size_bytes: number | null;
  v_page_count: number | null;
  chunk_count: number;
}

const DOC_SELECT = `
  select d.*, u.name as owner_name, v.version as v_version, v.file_name as v_file_name, v.mime_type as v_mime_type,
         v.size_bytes as v_size_bytes, v.page_count as v_page_count,
         (select count(*)::int from chunks c where c.version_id = d.current_version_id) as chunk_count
  from documents d
  left join users u on u.id = d.owner_id
  left join lateral (
    select * from document_versions dv
    where dv.id = d.current_version_id or (d.current_version_id is null and dv.document_id = d.id)
    order by dv.version desc limit 1
  ) v on true`;

const toDto = (r: DocRow): DocumentDTO => ({
  id: r.id,
  title: r.title,
  description: r.description,
  category: r.category,
  area: r.area,
  classification: r.classification,
  allowedGroups: r.allowed_groups ?? [],
  subjectKey: r.subject_key,
  status: r.status,
  ownerId: r.owner_id,
  ownerName: r.owner_name,
  currentVersion: r.v_version ?? 0,
  fileName: r.v_file_name,
  mimeType: r.v_mime_type,
  sizeBytes: r.v_size_bytes,
  pageCount: r.v_page_count,
  chunkCount: r.chunk_count ?? 0,
  flags: r.flags ?? [],
  error: r.error,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const DocumentListFilterSchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(80).optional(),
  area: z.string().trim().max(80).optional(),
  status: z.enum(['pending', 'processing', 'ready', 'failed', 'archived']).optional(),
  type: z.enum(['pdf', 'docx', 'xlsx', 'csv', 'txt', 'md']).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type DocumentListFilter = z.infer<typeof DocumentListFilterSchema>;

export const DocumentUpdateSchema = DocumentMetadataInputSchema.partial();

export interface DocumentServiceDeps {
  db: Db;
  storage: StorageProvider;
  scanner: MalwareScanner;
  embeddings: EmbeddingProvider;
  audit: AuditService;
  logger: Logger;
  authSecret: string;
  maxUploadBytes: number;
}

const EXT_BY_MIME: Record<string, SupportedExt> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/markdown': 'md',
};

export class DocumentService {
  constructor(private readonly deps: DocumentServiceDeps) {}

  private get db() {
    return this.deps.db;
  }

  // ───────────────────────── Leitura (sempre com ACL) ─────────────────────────

  async list(p: Principal, filter: DocumentListFilter): Promise<{ items: DocumentDTO[]; total: number }> {
    assertCan(p, 'documents:read');
    const acl = documentAccessSql(p, 'd', 1);
    const params: unknown[] = [...acl.params];
    const where = [acl.sql];
    const add = (sql: (n: number) => string, value: unknown) => {
      params.push(value);
      where.push(sql(params.length));
    };
    if (filter.status) add((n) => `d.status = $${n}`, filter.status);
    else where.push(`d.status <> 'archived'`);
    if (filter.category) add((n) => `d.category = $${n}`, filter.category);
    if (filter.area) add((n) => `d.area = $${n}`, filter.area);
    if (filter.from) add((n) => `d.updated_at >= $${n}::date`, filter.from);
    if (filter.to) add((n) => `d.updated_at < ($${n}::date + 1)`, filter.to);
    if (filter.type) add((n) => `v.file_name ilike $${n}`, `%.${filter.type}`);
    if (filter.q) {
      // Nome, descrição, categoria ou conteúdo (full-text nos trechos da versão atual).
      params.push(`%${filter.q.replace(/[%_]/g, '')}%`, filter.q);
      const like = params.length - 1;
      const fts = params.length;
      where.push(`(d.title ilike $${like} or d.description ilike $${like} or d.category ilike $${like}
        or exists (select 1 from chunks c where c.version_id = d.current_version_id and c.tsv @@ plainto_tsquery('portuguese', unaccent($${fts}))))`);
    }
    const whereSql = where.join(' and ');
    const total = (await this.db.one<{ n: number }>(`select count(*)::int as n from (${DOC_SELECT} where ${whereSql}) x`, params))?.n ?? 0;
    params.push(filter.limit, filter.offset);
    const rows = await this.db.query<DocRow>(`${DOC_SELECT} where ${whereSql} order by d.updated_at desc limit $${params.length - 1} offset $${params.length}`, params);
    return { items: rows.map(toDto), total };
  }

  /** Busca por id aplicando ACL. Documento invisível ao usuário = 404 (não revela existência). */
  async get(p: Principal, id: string): Promise<DocumentDTO> {
    assertCan(p, 'documents:read');
    if (!z.string().uuid().safeParse(id).success) throw new NotFoundError('Documento não encontrado');
    const acl = documentAccessSql(p, 'd', 2);
    const row = await this.db.one<DocRow>(`${DOC_SELECT} where d.id = $1 and ${acl.sql}`, [id, ...acl.params]);
    if (!row) throw new NotFoundError('Documento não encontrado');
    return toDto(row);
  }

  async versions(p: Principal, id: string): Promise<DocumentVersionDTO[]> {
    await this.get(p, id);
    const rows = await this.db.query<{ id: string; version: number; file_name: string; size_bytes: number; status: DocumentStatus; uploader: string | null; created_at: Date; error: string | null }>(
      `select v.*, u.name as uploader from document_versions v left join users u on u.id = v.uploaded_by where v.document_id = $1 order by v.version desc`,
      [id],
    );
    return rows.map((r) => ({ id: r.id, version: r.version, fileName: r.file_name, sizeBytes: r.size_bytes, status: r.status, uploadedBy: r.uploader, createdAt: iso(r.created_at), error: r.error }));
  }

  async categories(): Promise<string[]> {
    return (await this.db.query<{ name: string }>('select name from categories order by name')).map((r) => r.name);
  }

  // ───────────────────────── Escrita ─────────────────────────

  private async assertMetadataAllowed(p: Principal, meta: Pick<DocumentMetadataInput, 'area' | 'classification' | 'category'>) {
    if (p.role !== 'admin' && !effectiveGroups(p).includes(meta.area.toLowerCase())) {
      throw new ForbiddenError('Gestores só podem publicar documentos da própria área');
    }
    if (CLASSIFICATION_RANK[meta.classification] > CLASSIFICATION_RANK[p.clearance]) {
      throw new ForbiddenError('Classificação acima da sua habilitação');
    }
    const cat = await this.db.one('select 1 from categories where name = $1', [meta.category]);
    if (!cat) throw new ValidationError(`Categoria inexistente: ${meta.category}`);
  }

  /**
   * Recebe um arquivo (novo documento ou nova versão), valida, escaneia, armazena e enfileira o processamento.
   * O processamento (extração → chunking → embeddings → índice) é assíncrono.
   */
  async upload(
    p: Principal,
    input: { fileName: string; data: Buffer; metadata?: unknown; documentId?: string; ip?: string | null },
  ): Promise<DocumentDTO> {
    const isNewVersion = Boolean(input.documentId);
    assertCan(p, isNewVersion ? 'documents:update' : 'documents:upload');

    let existing: DocumentDTO | undefined;
    let metadata: DocumentMetadataInput | undefined;
    if (isNewVersion) {
      existing = await this.get(p, input.documentId!);
      if (!canManageDocument(p, existing)) throw new ForbiddenError();
      if (existing.status === 'archived') throw new ConflictError('Documento arquivado');
    } else {
      const parsed = DocumentMetadataInputSchema.safeParse(input.metadata);
      if (!parsed.success) throw new ValidationError('Metadados inválidos', parsed.error.flatten());
      metadata = parsed.data;
      await this.assertMetadataAllowed(p, metadata);
    }

    const file = await validateFile(input.fileName, input.data, this.deps.maxUploadBytes).catch(async (err) => {
      await this.deps.audit.record({ actorId: p.id, action: 'document.upload_rejected', outcome: 'denied', metadata: { reason: (err as Error).message, fileName: input.fileName.slice(0, 120) }, ip: input.ip });
      throw err;
    });
    const scan = await this.deps.scanner.scan(input.data);
    if (!scan.clean) {
      await this.deps.audit.record({ actorId: p.id, action: 'document.malware_detected', outcome: 'denied', metadata: { signature: scan.signature, sha256: file.sha256 }, ip: input.ip });
      throw new FileRejectedError('Arquivo bloqueado pelo antivírus');
    }
    const flags = [...file.flags, ...(scan.engine === 'none' ? ['not_scanned'] : [])];

    if (existing) {
      const same = await this.db.one(`select 1 from document_versions where id = (select current_version_id from documents where id = $1) and sha256 = $2`, [existing.id, file.sha256]);
      if (same) throw new ConflictError('O arquivo é idêntico à versão atual');
    }

    const docId = existing?.id ?? randomUUID();
    const versionId = randomUUID();
    const storageKey = `docs/${docId}/${versionId}`;
    await this.deps.storage.put(storageKey, input.data);

    try {
      await this.db.transaction(async (tx) => {
        if (!existing && metadata) {
          await tx.query(
            `insert into documents (id, title, description, category, area, classification, allowed_groups, subject_key, status, owner_id, proposal_id, flags)
             values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11)`,
            [docId, metadata.title, metadata.description, metadata.category, metadata.area, metadata.classification, metadata.allowedGroups, metadata.subjectKey ?? null, p.id, metadata.proposalId ?? null, flags],
          );
        } else {
          await tx.query(`update documents set flags = $2, updated_at = now(), status = case when current_version_id is null then 'pending' else status end where id = $1`, [docId, flags]);
        }
        const next = await tx.query<{ n: number }>('select coalesce(max(version), 0)::int + 1 as n from document_versions where document_id = $1', [docId]);
        await tx.query(
          `insert into document_versions (id, document_id, version, file_name, mime_type, size_bytes, sha256, storage_key, status, uploaded_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
          [versionId, docId, next[0]!.n, file.fileName, file.mime, file.size, file.sha256, storageKey, p.id],
        );
        await tx.query('insert into ingestion_jobs (id, version_id) values ($1, $2)', [randomUUID(), versionId]);
      });
    } catch (err) {
      await this.deps.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }

    await this.deps.audit.record({
      actorId: p.id,
      action: isNewVersion ? 'document.version_uploaded' : 'document.uploaded',
      targetType: 'document',
      targetId: docId,
      metadata: { fileName: file.fileName, size: file.size, sha256: file.sha256, flags },
      ip: input.ip,
    });
    return this.get(p, docId);
  }

  async updateMetadata(p: Principal, id: string, patch: unknown, ip?: string | null): Promise<DocumentDTO> {
    assertCan(p, 'documents:update');
    const doc = await this.get(p, id);
    if (!canManageDocument(p, doc)) throw new ForbiddenError();
    const parsed = DocumentUpdateSchema.safeParse(patch);
    if (!parsed.success) throw new ValidationError('Metadados inválidos', parsed.error.flatten());
    const next = { ...doc, ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) } as DocumentDTO & { proposalId?: string };
    await this.assertMetadataAllowed(p, next);
    await this.db.query(
      `update documents set title = $2, description = $3, category = $4, area = $5, classification = $6, allowed_groups = $7, subject_key = $8, updated_at = now() where id = $1`,
      [id, next.title, next.description, next.category, next.area, next.classification, next.allowedGroups, next.subjectKey ?? null],
    );
    await this.deps.audit.record({ actorId: p.id, action: 'document.metadata_updated', targetType: 'document', targetId: id, metadata: { fields: Object.keys(parsed.data) }, ip });
    return this.get(p, id);
  }

  /** Arquiva: o documento sai das buscas e do chat, mas arquivos e histórico são mantidos. */
  async archive(p: Principal, id: string, ip?: string | null): Promise<void> {
    assertCan(p, 'documents:archive');
    const doc = await this.get(p, id);
    if (!canManageDocument(p, doc)) throw new ForbiddenError();
    await this.db.query(`update documents set status = 'archived', updated_at = now() where id = $1`, [id]);
    await this.deps.audit.record({ actorId: p.id, action: 'document.archived', targetType: 'document', targetId: id, ip });
  }

  async restore(p: Principal, id: string, ip?: string | null): Promise<DocumentDTO> {
    assertCan(p, 'documents:archive');
    const doc = await this.get(p, id);
    if (!canManageDocument(p, doc)) throw new ForbiddenError();
    await this.db.query(`update documents set status = case when current_version_id is null then 'failed' else 'ready' end, updated_at = now() where id = $1`, [id]);
    await this.deps.audit.record({ actorId: p.id, action: 'document.restored', targetType: 'document', targetId: id, ip });
    return this.get(p, id);
  }

  /** Exclusão definitiva (LGPD/retenção): remove arquivos, versões, trechos e embeddings. Somente admin. */
  async purge(p: Principal, id: string, ip?: string | null): Promise<void> {
    assertCan(p, 'documents:purge');
    await this.get(p, id);
    const keys = await this.db.query<{ storage_key: string }>('select storage_key from document_versions where document_id = $1', [id]);
    await this.db.query('delete from documents where id = $1', [id]);
    for (const k of keys) await this.deps.storage.delete(k.storage_key).catch(() => undefined);
    await this.deps.audit.record({ actorId: p.id, action: 'document.purged', targetType: 'document', targetId: id, metadata: { versions: keys.length }, ip });
  }

  // ───────────────────────── Download seguro ─────────────────────────

  async createDownloadToken(p: Principal, documentId: string, versionId?: string): Promise<string> {
    const doc = await this.get(p, documentId);
    const vId = versionId ?? (await this.db.one<{ id: string }>('select current_version_id as id from documents where id = $1', [doc.id]))?.id;
    if (!vId) throw new NotFoundError('Documento sem versão disponível');
    return signDownloadToken(this.deps.authSecret, { documentId: doc.id, versionId: vId, userId: p.id });
  }

  /** Valida o link assinado, confirma que pertence ao usuário e revalida a ACL antes de servir o arquivo. */
  async resolveDownload(p: Principal, token: string, ip?: string | null): Promise<{ data: Buffer; fileName: string; mime: string }> {
    const claims = verifyDownloadToken(this.deps.authSecret, token);
    if (claims.userId !== p.id) throw new ForbiddenError('Link emitido para outro usuário');
    const row = await this.db.one<{ storage_key: string; file_name: string; mime_type: string; classification: DocumentDTO['classification']; allowed_groups: string[]; status: string }>(
      `select v.storage_key, v.file_name, v.mime_type, d.classification, d.allowed_groups, d.status
       from document_versions v join documents d on d.id = v.document_id where v.id = $1 and d.id = $2`,
      [claims.versionId, claims.documentId],
    );
    if (!row || row.status === 'archived' || !canReadDocument(p, { classification: row.classification, allowedGroups: row.allowed_groups })) {
      await this.deps.audit.record({ actorId: p.id, action: 'document.download', targetType: 'document', targetId: claims.documentId, outcome: 'denied', ip });
      throw new NotFoundError('Documento não encontrado');
    }
    const data = await this.deps.storage.get(row.storage_key);
    await this.deps.audit.record({ actorId: p.id, action: 'document.download', targetType: 'document', targetId: claims.documentId, metadata: { versionId: claims.versionId }, ip });
    return { data, fileName: row.file_name, mime: row.mime_type };
  }

  // ───────────────────────── Processamento (worker) ─────────────────────────

  /** Pega o próximo job da fila (seguro para múltiplos workers) e processa. Retorna false se a fila estiver vazia. */
  async processNextJob(): Promise<boolean> {
    await this.db.query(`update ingestion_jobs set status = 'queued', locked_at = null where status = 'running' and locked_at < now() - interval '15 minutes'`);
    const job = await this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string; version_id: string; attempts: number }>(
        `update ingestion_jobs set status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
         where id = (select id from ingestion_jobs where status = 'queued' and run_after <= now() order by created_at for update skip locked limit 1)
         returning id, version_id, attempts`,
      );
      return rows[0];
    });
    if (!job) return false;
    try {
      await this.processVersion(job.version_id);
      await this.db.query(`update ingestion_jobs set status = 'done', last_error = null, updated_at = now() where id = $1`, [job.id]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido';
      const permanent = err instanceof FileRejectedError || job.attempts >= 3;
      this.deps.logger.warn({ jobId: job.id, attempts: job.attempts, err: message }, 'ingestion_failed');
      await this.db.query(
        `update ingestion_jobs set status = $2, last_error = $3, locked_at = null, run_after = now() + ($4 || ' seconds')::interval, updated_at = now() where id = $1`,
        [job.id, permanent ? 'failed' : 'queued', message.slice(0, 500), String(30 * job.attempts)],
      );
      if (permanent) await this.markVersionFailed(job.version_id, message);
    }
    return true;
  }

  /** Processa a fila até esvaziá-la (útil em seed e testes). */
  async drainQueue(max = 1000): Promise<number> {
    let n = 0;
    while (n < max && (await this.processNextJob())) n++;
    return n;
  }

  private async markVersionFailed(versionId: string, message: string) {
    await this.db.query(`update document_versions set status = 'failed', error = $2 where id = $1`, [versionId, message.slice(0, 500)]);
    await this.db.query(
      `update documents set status = case when current_version_id is null then 'failed' else status end, error = $2, updated_at = now()
       where id = (select document_id from document_versions where id = $1)`,
      [versionId, message.slice(0, 500)],
    );
  }

  /** Extração → chunking → detecção de injection → embeddings → índice híbrido → troca atômica de versão. */
  async processVersion(versionId: string): Promise<void> {
    const v = await this.db.one<{ id: string; document_id: string; storage_key: string; mime_type: string; file_name: string; title: string; current_version_id: string | null; flags: string[] }>(
      `select v.*, d.title, d.current_version_id, d.flags from document_versions v join documents d on d.id = v.document_id where v.id = $1`,
      [versionId],
    );
    if (!v) throw new NotFoundError('Versão não encontrada');
    await this.db.query(`update document_versions set status = 'processing', error = null where id = $1`, [versionId]);
    await this.db.query(`update documents set status = case when current_version_id is null then 'processing' else status end where id = $1`, [v.document_id]);

    const ext = EXT_BY_MIME[v.mime_type];
    if (!ext) throw new FileRejectedError('Tipo de arquivo não suportado');
    const data = await this.deps.storage.get(v.storage_key);
    const extracted = await extractContent(ext, data);
    const chunks = chunkSections(extracted.sections);
    if (chunks.length === 0) throw new FileRejectedError('Nenhum texto extraível (PDF digitalizado? OCR não está habilitado)');

    const scans = chunks.map((c) => scanForInjection(c.content));
    const contextual = chunks.map((c) => `${v.title}${c.section ? ` — ${c.section}` : ''}\n${c.content}`);
    const vectors: number[][] = [];
    for (let i = 0; i < contextual.length; i += 64) vectors.push(...(await this.deps.embeddings.embed(contextual.slice(i, i + 64), 'document')));
    if (vectors.length !== chunks.length || vectors.some((x) => x.length !== this.deps.embeddings.dim)) throw new Error('Embeddings com dimensão inesperada');

    const suspicious = scans.some((s) => s.suspicious);
    await this.db.transaction(async (tx) => {
      await tx.query('delete from chunks where version_id = $1', [versionId]);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        await tx.query(
          `insert into chunks (id, document_id, version_id, ordinal, content, page, section, token_estimate, suspicious, embedding, tsv)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector,
             setweight(to_tsvector('portuguese', unaccent($11)), 'A') || setweight(to_tsvector('portuguese', unaccent(coalesce($7, ''))), 'B') || setweight(to_tsvector('portuguese', unaccent($5)), 'C'))`,
          [randomUUID(), v.document_id, versionId, c.ordinal, c.content, c.page, c.section, c.tokenEstimate, scans[i]!.suspicious, toVectorLiteral(vectors[i]!), v.title],
        );
      }
      await tx.query(`update document_versions set status = 'ready', page_count = $2, error = null where id = $1`, [versionId, extracted.pageCount]);
      // Versões anteriores saem do índice (ficam no histórico para auditoria/download).
      await tx.query(`delete from chunks where document_id = $1 and version_id <> $2`, [v.document_id, versionId]);
      await tx.query(`update document_versions set status = 'archived' where document_id = $1 and id <> $2 and status = 'ready'`, [v.document_id, versionId]);
      const flags = new Set((v.flags ?? []).filter((f) => f !== 'suspicious_content'));
      if (suspicious) flags.add('suspicious_content');
      await tx.query(
        `update documents set current_version_id = $2, status = case when status = 'archived' then 'archived' else 'ready' end, error = null, flags = $3, updated_at = now() where id = $1`,
        [v.document_id, versionId, [...flags]],
      );
    });
    this.deps.logger.info({ documentId: v.document_id, versionId, chunks: chunks.length, suspicious }, 'document_indexed');
  }

  /** Erros de processamento recentes (admin). */
  async ingestionErrors(p: Principal): Promise<{ documentId: string; title: string; version: number; fileName: string; error: string | null; attempts: number; at: string }[]> {
    assertCan(p, 'admin:ingestion');
    const rows = await this.db.query<{ document_id: string; title: string; version: number; file_name: string; error: string | null; attempts: number; updated_at: Date }>(
      `select v.document_id, d.title, v.version, v.file_name, coalesce(j.last_error, v.error) as error, j.attempts, j.updated_at
       from ingestion_jobs j join document_versions v on v.id = j.version_id join documents d on d.id = v.document_id
       where j.status = 'failed' or (j.status = 'queued' and j.attempts > 0)
       order by j.updated_at desc limit 100`,
    );
    return rows.map((r) => ({ documentId: r.document_id, title: r.title, version: r.version, fileName: r.file_name, error: r.error, attempts: r.attempts, at: iso(r.updated_at) }));
  }

  async retryFailed(p: Principal, documentId: string): Promise<void> {
    assertCan(p, 'admin:ingestion');
    await this.db.query(
      `update ingestion_jobs set status = 'queued', attempts = 0, run_after = now(), last_error = null, updated_at = now()
       where status = 'failed' and version_id in (select id from document_versions where document_id = $1)`,
      [documentId],
    );
    await this.deps.audit.record({ actorId: p.id, action: 'ingestion.retry', targetType: 'document', targetId: documentId });
  }
}
