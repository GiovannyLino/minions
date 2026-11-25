'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { EyeOff, Mail, Pencil, Plus, Search, Trash2, Users } from 'lucide-react';
import type { PersonDTO } from '@minions/core/contracts';
import { useSession } from '@/components/session';
import { PageHeader } from '@/components/shell';
import { Avatar, Badge, Button, Card, Drawer, EmptyState, ErrorState, Field, IconButton, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { ApiClientError, apiFetch, useApi } from '@/lib/api-client';

export default function PeoplePage() {
  const user = useSession();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [area, setArea] = useState('');
  const [editing, setEditing] = useState<PersonDTO | 'new' | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const all = useApi<PersonDTO[]>('/people');
  const params = new URLSearchParams();
  if (debounced) params.set('q', debounced);
  if (area) params.set('area', area);
  const list = useApi<PersonDTO[]>(`/people?${params}`);
  const areas = useMemo(() => [...new Set((all.data ?? []).map((p) => p.area))].sort(), [all.data]);

  return (
    <>
      <PageHeader
        title="Pessoas e Contatos"
        description="Quem sabe o quê. O People Agent usa estas especialidades e responsabilidades para indicar contatos."
        actions={user.can('people:write') ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Adicionar pessoa</Button> : null}
      />
      <div className="space-y-4 px-5 py-5 md:px-8">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, cargo, especialidade ou responsabilidade…" className="pl-9" aria-label="Buscar pessoas" />
          </div>
          <Select value={area} onChange={(e) => setArea(e.target.value)} className="sm:w-48" aria-label="Área">
            <option value="">Todas as áreas</option>
            {areas.map((a) => <option key={a}>{a}</option>)}
          </Select>
        </div>
        {list.error ? (
          <ErrorState message={list.error.message} onRetry={list.reload} />
        ) : list.loading && !list.data ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-36" />)}</div>
        ) : list.data?.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.data.map((p) => (
              <Card key={p.id} className="group p-4">
                <div className="flex items-start gap-3">
                  <Avatar name={p.name} size={38} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold">{p.name}</p>
                    <p className="truncate text-[12.5px] text-muted">{[p.jobTitle, p.area].filter(Boolean).join(' · ')}</p>
                  </div>
                  {user.can('people:write') ? (
                    <IconButton label="Editar" className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => setEditing(p)}>
                      <Pencil className="size-3.5" />
                    </IconButton>
                  ) : null}
                </div>
                {p.responsibilities.length ? (
                  <div className="mt-3">
                    <p className="text-[11px] font-semibold tracking-wide text-faint uppercase">Responsável por</p>
                    <ul className="mt-1 space-y-0.5 text-[12.5px] text-fg-2">{p.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
                  </div>
                ) : null}
                {p.expertise.length ? <div className="mt-3 flex flex-wrap gap-1">{p.expertise.map((e) => <Badge key={e}>{e}</Badge>)}</div> : null}
                {p.proposals.length ? (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {p.proposals.map((pr) => <Link key={pr.id} href={`/proposals/${pr.id}`} className="font-mono text-[11.5px] text-accent-text hover:underline">{pr.code}</Link>)}
                  </div>
                ) : null}
                <div className="mt-3 border-t border-line pt-3 text-[12.5px]">
                  {p.email ? (
                    <a href={`mailto:${p.email}`} className="inline-flex items-center gap-1.5 font-medium text-accent-text hover:underline"><Mail className="size-3.5" /> {p.email}</a>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-faint"><EyeOff className="size-3.5" /> Contato não autorizado para exibição</span>
                  )}
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Card><EmptyState icon={<Users className="size-4" />} title="Nenhuma pessoa encontrada" /></Card>
        )}
      </div>
      {editing ? <PersonForm person={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { void list.reload(); void all.reload(); }} /> : null}
    </>
  );
}

function PersonForm({ person, onClose, onSaved }: { person?: PersonDTO; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: person?.name ?? '',
    email: person?.email ?? '',
    jobTitle: person?.jobTitle ?? '',
    area: person?.area ?? '',
    expertise: (person?.expertise ?? []).join(', '),
    responsibilities: (person?.responsibilities ?? []).join('\n'),
    contactVisible: person?.contactVisible ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(person ? `/people/${person.id}` : '/people', {
        method: person ? 'PUT' : 'POST',
        body: JSON.stringify({
          ...f,
          email: f.email || null,
          jobTitle: f.jobTitle || null,
          expertise: f.expertise.split(',').map((x) => x.trim()).filter(Boolean),
          responsibilities: f.responsibilities.split('\n').map((x) => x.trim()).filter(Boolean),
          userId: person?.userId ?? null,
        }),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Falha ao salvar');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!person || !window.confirm(`Remover ${person.name} do diretório?`)) return;
    await apiFetch(`/people/${person.id}`, { method: 'DELETE' }).catch(() => undefined);
    onSaved();
    onClose();
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title={person ? 'Editar pessoa' : 'Adicionar pessoa'}
      subtitle="Use apenas dados corporativos. Não cadastre CPF, telefone pessoal ou endereço."
      footer={
        <>
          {person ? <Button variant="danger" icon={<Trash2 className="size-3.5" />} onClick={remove} className="mr-auto">Remover</Button> : null}
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} onClick={save} disabled={!f.name || !f.area}>Salvar</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Nome"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cargo ou função"><Input value={f.jobTitle} onChange={(e) => setF({ ...f, jobTitle: e.target.value })} /></Field>
          <Field label="Área"><Input value={f.area} onChange={(e) => setF({ ...f, area: e.target.value })} /></Field>
        </div>
        <Field label="E-mail corporativo"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-[13px] text-fg-2">
          <input type="checkbox" checked={f.contactVisible} onChange={(e) => setF({ ...f, contactVisible: e.target.checked })} className="size-4 accent-[var(--accent)]" />
          Contato autorizado para exibição aos colaboradores
        </label>
        <Field label="Especialidades" hint="Separadas por vírgula"><Input value={f.expertise} onChange={(e) => setF({ ...f, expertise: e.target.value })} /></Field>
        <Field label="Responsabilidades" hint="Uma por linha"><Textarea rows={4} value={f.responsibilities} onChange={(e) => setF({ ...f, responsibilities: e.target.value })} /></Field>
        {error ? <ErrorState message={error} /> : null}
      </div>
    </Drawer>
  );
}
