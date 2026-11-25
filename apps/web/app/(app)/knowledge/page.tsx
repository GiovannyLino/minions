'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Plus, Search, ShieldAlert } from 'lucide-react';
import { CLASSIFICATION_LABEL, type CategoryDTO, type DocumentDTO } from '@minions/core/contracts';
import { DocStatusBadge } from '@/components/knowledge/status';
import { UploadDrawer } from '@/components/knowledge/upload-drawer';
import { useSession } from '@/components/session';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Select, Skeleton } from '@/components/ui';
import { useApi } from '@/lib/api-client';
import { fileExt, fmtRelative } from '@/lib/format';

export default function KnowledgePage() {
  const user = useSession();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filters, setFilters] = useState({ category: '', area: '', status: '', type: '', from: '' });
  const [upload, setUpload] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: '100' });
    if (debounced) p.set('q', debounced);
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    return `/documents?${p}`;
  }, [debounced, filters]);
  const docs = useApi<{ items: DocumentDTO[]; total: number }>(query);
  const categories = useApi<CategoryDTO[]>('/documents/categories');
  const areas = useMemo(() => [...new Set((docs.data?.items ?? []).map((d) => d.area))].sort(), [docs.data]);

  // Atualiza enquanto há documentos sendo indexados.
  const processing = docs.data?.items.some((d) => d.status === 'pending' || d.status === 'processing');
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => void docs.reload(), 2500);
    return () => clearInterval(t);
  }, [processing, docs]);

  return (
    <>
      <PageHeader
        title="Base de Conhecimento"
        description="Documentos que alimentam os agentes. Você vê apenas o que sua permissão permite."
        actions={user.can('documents:upload') ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setUpload(true)}>Adicionar documento</Button> : null}
      />
      <div className="space-y-4 px-5 py-5 md:px-8">
        <div className="flex flex-col gap-2 lg:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, conteúdo ou categoria…" className="pl-9" aria-label="Buscar documentos" />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 lg:w-[640px]">
            <Select aria-label="Categoria" value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}>
              <option value="">Categoria</option>
              {categories.data?.map((c) => (
                <option key={c.id}>{c.name}</option>
              ))}
            </Select>
            <Select aria-label="Área" value={filters.area} onChange={(e) => setFilters((f) => ({ ...f, area: e.target.value }))}>
              <option value="">Área</option>
              {areas.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
            <Select aria-label="Tipo" value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}>
              <option value="">Tipo</option>
              {['pdf', 'docx', 'xlsx', 'csv', 'txt', 'md'].map((t) => (
                <option key={t} value={t}>
                  {t.toUpperCase()}
                </option>
              ))}
            </Select>
            <Select aria-label="Status" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
              <option value="">Status</option>
              <option value="ready">Indexado</option>
              <option value="processing">Indexando</option>
              <option value="pending">Na fila</option>
              <option value="failed">Falhou</option>
              <option value="archived">Arquivado</option>
            </Select>
            <Input aria-label="Atualizado desde" type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
          </div>
        </div>

        {docs.error ? (
          <ErrorState message={docs.error.message} onRetry={docs.reload} />
        ) : (
          <Card className="overflow-hidden">
            <div className="hidden grid-cols-[minmax(0,1fr)_140px_120px_110px_90px] gap-4 border-b border-line bg-surface-2/50 px-4 py-2 text-[11.5px] font-semibold tracking-wide text-muted uppercase md:grid">
              <span>Documento</span>
              <span>Classificação</span>
              <span>Status</span>
              <span>Versão</span>
              <span className="text-right">Atualizado</span>
            </div>
            {docs.loading && !docs.data ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-11" />
                ))}
              </div>
            ) : docs.data?.items.length ? (
              <ul className="divide-y divide-line">
                {docs.data.items.map((d) => (
                  <li key={d.id}>
                    <Link href={`/knowledge/${d.id}`} className="grid gap-2 px-4 py-3 transition-colors hover:bg-surface-2/60 md:grid-cols-[minmax(0,1fr)_140px_120px_110px_90px] md:items-center md:gap-4">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="flex h-8 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 font-mono text-[10px] font-semibold text-muted">{fileExt(d.fileName) || 'DOC'}</span>
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 truncate text-[13.5px] font-medium">
                            {d.title}
                            {d.flags.includes('suspicious_content') ? <ShieldAlert className="size-3.5 shrink-0 text-danger" aria-label="Conteúdo suspeito" /> : null}
                          </p>
                          <p className="truncate text-[12px] text-muted">
                            {d.category} · {d.area}
                            {d.ownerName ? ` · enviado por ${d.ownerName}` : ''}
                          </p>
                        </div>
                      </div>
                      <div>
                        <Badge tone={d.classification === 'confidential' ? 'danger' : d.classification === 'restricted' ? 'warning' : 'neutral'}>{CLASSIFICATION_LABEL[d.classification]}</Badge>
                      </div>
                      <div>
                        <DocStatusBadge status={d.status} />
                      </div>
                      <span className="text-[12.5px] text-muted">
                        v{d.currentVersion || 1} · {d.chunkCount} trechos
                      </span>
                      <span className="text-[12px] text-faint md:text-right">{fmtRelative(d.updatedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={<BookOpen className="size-4" />}
                title={debounced || Object.values(filters).some(Boolean) ? 'Nenhum documento encontrado' : 'A base ainda está vazia'}
                description={debounced ? 'Tente outros termos ou remova filtros.' : user.can('documents:upload') ? 'Adicione o primeiro documento para os agentes consultarem.' : 'Peça a um gestor para publicar documentos da sua área.'}
              />
            )}
          </Card>
        )}
        {docs.data ? <p className="text-[12px] text-faint">{docs.data.total} documento(s)</p> : null}
      </div>
      {categories.data ? <UploadDrawer open={upload} onClose={() => setUpload(false)} onDone={() => void docs.reload()} categories={categories.data} /> : null}
    </>
  );
}
