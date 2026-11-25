'use client';

import { useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { CLASSIFICATIONS, CLASSIFICATION_LABEL, type CategoryDTO, type Classification, type DocumentDTO } from '@minions/core/contracts';
import { ApiClientError, apiFetch } from '@/lib/api-client';
import { fmtBytes } from '@/lib/format';
import { useSession } from '../session';
import { Button, Drawer, ErrorState, Field, Input, Select, Textarea } from '../ui';

const ACCEPT = '.pdf,.docx,.xlsx,.csv,.txt,.md';

/** Upload de novo documento ou de nova versão (quando `document` é informado). */
export function UploadDrawer({ open, onClose, onDone, categories, document }: { open: boolean; onClose: () => void; onDone: (d: DocumentDTO) => void; categories: CategoryDTO[]; document?: DocumentDTO }) {
  const user = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState({ title: '', description: '', category: categories[0]?.name ?? '', area: user.area ?? '', classification: 'internal' as Classification, allowedGroups: '', subjectKey: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const set = (k: keyof typeof meta, v: string) => setMeta((m) => ({ ...m, [k]: v }));
  const restricted = meta.classification === 'restricted' || meta.classification === 'confidential';

  const submit = async () => {
    if (!file) return setError('Selecione um arquivo.');
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('file', file);
    if (!document) {
      const groups = meta.allowedGroups.split(',').map((g) => g.trim().toLowerCase()).filter(Boolean);
      form.set('metadata', JSON.stringify({ ...meta, subjectKey: meta.subjectKey || undefined, allowedGroups: restricted && groups.length === 0 && meta.area ? [meta.area.toLowerCase()] : groups }));
    }
    try {
      const doc = await apiFetch<DocumentDTO>(document ? `/documents/${document.id}/versions` : '/documents', { method: 'POST', body: form });
      onDone(doc);
      setFile(null);
      onClose();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Falha no envio');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={document ? 'Enviar nova versão' : 'Adicionar documento'}
      subtitle={document ? document.title : 'O arquivo é validado, verificado e indexado automaticamente.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" loading={busy} onClick={submit} disabled={!file || (!document && (!meta.title || !meta.category || !meta.area))}>
            Enviar
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f) {
              setFile(f);
              if (!meta.title) set('title', f.name.replace(/\.[^.]+$/, ''));
            }
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors ${drag ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong hover:bg-surface-2/50'}`}
        >
          <UploadCloud className="size-6 text-muted" />
          {file ? (
            <p className="mt-2 text-[13.5px] font-medium">
              {file.name} <span className="font-normal text-muted">· {fmtBytes(file.size)}</span>
            </p>
          ) : (
            <>
              <p className="mt-2 text-[13.5px] font-medium">Arraste um arquivo ou clique para selecionar</p>
              <p className="mt-0.5 text-[12px] text-muted">PDF, DOCX, XLSX, CSV, TXT ou MD · arquivos com macros são recusados</p>
            </>
          )}
          <input
            type="file"
            accept={ACCEPT}
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !meta.title) set('title', f.name.replace(/\.[^.]+$/, ''));
            }}
          />
        </label>

        {!document ? (
          <>
            <Field label="Nome">
              <Input value={meta.title} onChange={(e) => set('title', e.target.value)} maxLength={200} />
            </Field>
            <Field label="Descrição">
              <Textarea rows={2} value={meta.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Categoria">
                <Select value={meta.category} onChange={(e) => set('category', e.target.value)}>
                  {categories.map((c) => (
                    <option key={c.id}>{c.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Área responsável" hint={user.role === 'admin' ? undefined : 'Gestores publicam somente na própria área'}>
                <Input value={meta.area} onChange={(e) => set('area', e.target.value)} />
              </Field>
            </div>
            <Field label="Classificação" hint="Ninguém acima desta habilitação verá o conteúdo — nem nas respostas dos agentes.">
              <Select value={meta.classification} onChange={(e) => set('classification', e.target.value)}>
                {CLASSIFICATIONS.map((c) => (
                  <option key={c} value={c}>
                    {CLASSIFICATION_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
            {restricted ? (
              <Field label="Grupos com acesso" hint="Separe por vírgula (ex.: comercial, engenharia). Vazio = somente a área responsável.">
                <Input value={meta.allowedGroups} onChange={(e) => set('allowedGroups', e.target.value)} />
              </Field>
            ) : null}
            <Field label="Chave de assunto (opcional)" hint="Documentos com a mesma chave são comparados para detectar divergências (ex.: politica-reembolso).">
              <Input value={meta.subjectKey} onChange={(e) => set('subjectKey', e.target.value)} />
            </Field>
          </>
        ) : (
          <p className="text-[13px] text-muted">A versão atual continua disponível até a nova ser indexada com sucesso. O histórico é preservado.</p>
        )}
        {error ? <ErrorState message={error} /> : null}
      </div>
    </Drawer>
  );
}
