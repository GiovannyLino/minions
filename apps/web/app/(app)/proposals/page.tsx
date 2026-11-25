'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Briefcase, CalendarClock, Plus, Search } from 'lucide-react';
import { CLASSIFICATION_LABEL, PROPOSAL_STATUSES, PROPOSAL_STATUS_LABEL, type ProposalDTO } from '@minions/core/contracts';
import { ProposalForm } from '@/components/proposals/proposal-form';
import { ProposalStatusBadge } from '@/components/proposals/status';
import { useSession } from '@/components/session';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Select, Skeleton } from '@/components/ui';
import { useApi } from '@/lib/api-client';
import { fmtDate } from '@/lib/format';

export default function ProposalsPage() {
  const user = useSession();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const params = new URLSearchParams();
  if (debounced) params.set('q', debounced);
  if (status) params.set('status', status);
  const list = useApi<ProposalDTO[]>(`/proposals?${params}`);

  return (
    <>
      <PageHeader
        title="Propostas e Projetos"
        description="Cadastro estruturado usado pelo Proposal Agent. Informações não cadastradas nunca são inventadas."
        actions={user.can('proposals:write') ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Nova proposta</Button> : null}
      />
      <div className="space-y-4 px-5 py-5 md:px-8">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por código, nome ou cliente…" className="pl-9" aria-label="Buscar propostas" />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-48" aria-label="Status">
            <option value="">Todos os status</option>
            {PROPOSAL_STATUSES.map((s) => <option key={s} value={s}>{PROPOSAL_STATUS_LABEL[s]}</option>)}
          </Select>
        </div>
        {list.error ? (
          <ErrorState message={list.error.message} onRetry={list.reload} />
        ) : list.loading && !list.data ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-40" />)}</div>
        ) : list.data?.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.data.map((p) => (
              <Link key={p.id} href={`/proposals/${p.id}`}>
                <Card interactive className="flex h-full flex-col p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[12px] font-medium text-muted">{p.code}</span>
                    <ProposalStatusBadge status={p.status} />
                  </div>
                  <h3 className="mt-2 text-[14.5px] font-semibold leading-snug">{p.name}</h3>
                  <p className="mt-0.5 text-[12.5px] text-muted">{p.client || 'Cliente não informado'}</p>
                  <p className="mt-3 line-clamp-2 flex-1 text-[12.5px] text-fg-2">{p.description || 'Sem descrição cadastrada.'}</p>
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[12px] text-muted">
                    <span>{p.ownerName ?? 'Sem responsável'}</span>
                    {p.dueDate ? <span className="flex items-center gap-1"><CalendarClock className="size-3.5" /> {fmtDate(p.dueDate)}</span> : null}
                    <Badge className="ml-auto">{CLASSIFICATION_LABEL[p.classification]}</Badge>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState icon={<Briefcase className="size-4" />} title="Nenhuma proposta encontrada" description="As propostas aparecem aqui conforme sua permissão de acesso." />
          </Card>
        )}
      </div>
      {creating ? <ProposalForm onClose={() => setCreating(false)} onSaved={() => void list.reload()} /> : null}
    </>
  );
}
