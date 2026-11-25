'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { Archive, ArchiveRestore, ArrowLeft, Download, FileUp, Pencil, ShieldAlert, Trash2 } from 'lucide-react';
import { CLASSIFICATIONS, CLASSIFICATION_LABEL, type CategoryDTO, type Classification, type DocumentDTO, type DocumentVersionDTO } from '@minions/core/contracts';
import { DocStatusBadge, FLAG_LABEL } from '@/components/knowledge/status';
import { UploadDrawer } from '@/components/knowledge/upload-drawer';
import { useSession } from '@/components/session';
import { Badge, Button, Card, Drawer, ErrorState, Field, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { ApiClientError, apiFetch, useApi } from '@/lib/api-client';
import { fmtBytes, fmtDateTime } from '@/lib/format';

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const user = useSession();
  const router = useRouter();
  const doc = useApi<DocumentDTO>(`/documents/${id}`);
  const versions = useApi<DocumentVersionDTO[]>(`/documents/${id}/versions`);
  const categories = useApi<CategoryDTO[]>('/documents/categories');
  const [upload, setUpload] = useState(false);
  const [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const d = doc.data;
  const canManage = d && (user.role === 'admin' || (user.role === 'manager' && (d.ownerId === user.id || [user.area?.toLowerCase(), ...user.groups].includes(d.area.toLowerCase()))));

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
      await Promise.all([doc.reload(), versions.reload()]);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Falha na operação');
    } finally {
      setBusy(null);
    }
  };
  const download = (versionId?: string) =>
    act('download', async () => {
      const { url } = await apiFetch<{ url: string }>(`/documents/${id}/download-link${versionId ? `?version=${versionId}` : ''}`, { method: 'POST' });
      window.location.href = url;
    });

  if (doc.error) return <div className="p-8"><ErrorState message={doc.error.status === 404 ? 'Documento não encontrado ou sem permissão de acesso.' : doc.error.message} /></div>;
  if (!d) return <div className="space-y-3 p-8"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-40" /></div>;

  return (
    <div className="mx-auto w-full max-w-[980px] px-5 py-6 md:px-8">
      <Link href="/knowledge" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Base de Conhecimento
      </Link>
      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[21px] font-semibold tracking-tight">{d.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <DocStatusBadge status={d.status} />
            <Badge tone={d.classification === 'confidential' ? 'danger' : d.classification === 'restricted' ? 'warning' : 'neutral'}>{CLASSIFICATION_LABEL[d.classification]}</Badge>
            <Badge>{d.category}</Badge>
            <span className="text-[12px] text-muted">v{d.currentVersion || 1}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {d.status !== 'archived' && d.currentVersion ? <Button icon={<Download className="size-3.5" />} loading={busy === 'download'} onClick={() => download()}>Baixar</Button> : null}
          {canManage ? (
            <>
              <Button icon={<Pencil className="size-3.5" />} onClick={() => setEdit(true)}>Editar</Button>
              {d.status !== 'archived' ? <Button icon={<FileUp className="size-3.5" />} onClick={() => setUpload(true)}>Nova versão</Button> : null}
              {d.status === 'archived' ? (
                <Button icon={<ArchiveRestore className="size-3.5" />} loading={busy === 'restore'} onClick={() => act('restore', () => apiFetch(`/documents/${id}/restore`, { method: 'POST' }))}>Restaurar</Button>
              ) : (
                <Button icon={<Archive className="size-3.5" />} loading={busy === 'archive'} onClick={() => act('archive', () => apiFetch(`/documents/${id}/archive`, { method: 'POST' }))}>Arquivar</Button>
              )}
            </>
          ) : null}
          {user.can('documents:purge') ? (
            <Button
              variant="danger"
              icon={<Trash2 className="size-3.5" />}
              loading={busy === 'purge'}
              onClick={() => {
                if (!window.confirm(`Excluir definitivamente "${d.title}"? Arquivos, versões, trechos e embeddings serão apagados. Esta ação não pode ser desfeita.`)) return;
                void act('purge', async () => {
                  await apiFetch(`/documents/${id}`, { method: 'DELETE' });
                  router.push('/knowledge');
                });
              }}
            >
              Excluir
            </Button>
          ) : null}
        </div>
      </div>

      {error ? <div className="mt-4"><ErrorState message={error} /></div> : null}
      {d.error && d.status === 'failed' ? <div className="mt-4"><ErrorState message={`Falha na indexação: ${d.error}`} /></div> : null}
      {d.flags.length ? (
        <div className="mt-4 space-y-1.5">
          {d.flags.map((f) => (
            <div key={f} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] ${f === 'suspicious_content' ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-muted'}`}>
              <ShieldAlert className="size-3.5" /> {FLAG_LABEL[f] ?? f}
              {f === 'suspicious_content' ? <span className="text-fg-2">— os agentes tratam o conteúdo como dado e nunca seguem instruções contidas nele.</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h2 className="text-[13px] font-semibold">Metadados</h2>
          {d.description ? <p className="mt-2 text-[13.5px] text-fg-2">{d.description}</p> : null}
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
            {[
              ['Área responsável', d.area],
              ['Enviado por', d.ownerName ?? '—'],
              ['Incluído em', fmtDateTime(d.createdAt)],
              ['Última atualização', fmtDateTime(d.updatedAt)],
              ['Arquivo', d.fileName ?? '—'],
              ['Tamanho', fmtBytes(d.sizeBytes)],
              ['Páginas', d.pageCount ?? '—'],
              ['Trechos indexados', d.chunkCount],
              ['Grupos com acesso', d.allowedGroups.length ? d.allowedGroups.join(', ') : 'Todos dentro da classificação'],
              ['Chave de assunto', d.subjectKey ?? '—'],
            ].map(([k, v]) => (
              <div key={String(k)}>
                <dt className="text-[11.5px] text-muted">{k}</dt>
                <dd className="mt-0.5 truncate font-medium text-fg-2">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card className="p-5">
          <h2 className="text-[13px] font-semibold">Histórico de versões</h2>
          {versions.data ? (
            <ol className="mt-3 space-y-3">
              {versions.data.map((v) => (
                <li key={v.id} className="flex items-start gap-3 text-[12.5px]">
                  <span className="mt-0.5 font-mono text-[11.5px] font-semibold text-muted">v{v.version}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-fg-2">{v.fileName}</p>
                    <p className="text-muted">
                      {fmtDateTime(v.createdAt)} · {v.uploadedBy ?? '—'}
                    </p>
                    {v.error ? <p className="text-danger">{v.error}</p> : null}
                  </div>
                  <span className="flex flex-col items-end gap-1">
                    <Badge tone={v.status === 'ready' ? 'success' : v.status === 'failed' ? 'danger' : 'neutral'}>{v.status === 'ready' ? 'Atual' : v.status === 'archived' ? 'Anterior' : v.status === 'failed' ? 'Falhou' : 'Processando'}</Badge>
                    {v.status === 'archived' || v.status === 'ready' ? (
                      <button className="text-[11.5px] font-medium text-accent-text hover:underline" onClick={() => download(v.id)}>
                        Baixar
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <Skeleton className="mt-3 h-20" />
          )}
        </Card>
      </div>

      {categories.data ? <UploadDrawer open={upload} onClose={() => setUpload(false)} onDone={() => void Promise.all([doc.reload(), versions.reload()])} categories={categories.data} document={d} /> : null}
      {edit && categories.data ? <EditDrawer doc={d} categories={categories.data} onClose={() => setEdit(false)} onSaved={(n) => doc.setData(n)} /> : null}
    </div>
  );
}

function EditDrawer({ doc, categories, onClose, onSaved }: { doc: DocumentDTO; categories: CategoryDTO[]; onClose: () => void; onSaved: (d: DocumentDTO) => void }) {
  const [m, setM] = useState({ title: doc.title, description: doc.description, category: doc.category, area: doc.area, classification: doc.classification as Classification, allowedGroups: doc.allowedGroups.join(', '), subjectKey: doc.subjectKey ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await apiFetch<DocumentDTO>(`/documents/${doc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...m, subjectKey: m.subjectKey || undefined, allowedGroups: m.allowedGroups.split(',').map((g) => g.trim().toLowerCase()).filter(Boolean) }),
      });
      onSaved(out);
      onClose();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Falha ao salvar');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer open onClose={onClose} title="Editar metadados" subtitle="Alterações de classificação e grupos valem imediatamente para buscas e respostas." footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save}>Salvar</Button></>}>
      <div className="space-y-4">
        <Field label="Nome"><Input value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} /></Field>
        <Field label="Descrição"><Textarea rows={3} value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Categoria">
            <Select value={m.category} onChange={(e) => setM({ ...m, category: e.target.value })}>{categories.map((c) => <option key={c.id}>{c.name}</option>)}</Select>
          </Field>
          <Field label="Área"><Input value={m.area} onChange={(e) => setM({ ...m, area: e.target.value })} /></Field>
        </div>
        <Field label="Classificação">
          <Select value={m.classification} onChange={(e) => setM({ ...m, classification: e.target.value as Classification })}>{CLASSIFICATIONS.map((c) => <option key={c} value={c}>{CLASSIFICATION_LABEL[c]}</option>)}</Select>
        </Field>
        <Field label="Grupos com acesso" hint="Separados por vírgula; vazio = todos dentro da classificação"><Input value={m.allowedGroups} onChange={(e) => setM({ ...m, allowedGroups: e.target.value })} /></Field>
        <Field label="Chave de assunto"><Input value={m.subjectKey} onChange={(e) => setM({ ...m, subjectKey: e.target.value })} /></Field>
        {error ? <ErrorState message={error} /> : null}
      </div>
    </Drawer>
  );
}
