'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { ArrowLeft, FileText, MessageSquare, Pencil } from 'lucide-react';
import { CLASSIFICATION_LABEL, type ProposalDTO } from '@minions/core/contracts';
import { ProposalForm } from '@/components/proposals/proposal-form';
import { ProposalStatusBadge } from '@/components/proposals/status';
import { useSession } from '@/components/session';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { useApi } from '@/lib/api-client';
import { fmtDate, fmtDateTime } from '@/lib/format';

export default function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const user = useSession();
  const p = useApi<ProposalDTO>(`/proposals/${id}`);
  const [edit, setEdit] = useState(false);

  if (p.error) return <div className="p-8"><ErrorState message={p.error.status === 404 ? 'Proposta não encontrada ou sem permissão de acesso.' : p.error.message} /></div>;
  if (!p.data) return <div className="space-y-3 p-8"><Skeleton className="h-8 w-1/2" /><Skeleton className="h-48" /></div>;
  const d = p.data;
  const canEdit = user.can('proposals:write') && (user.role === 'admin' || [user.area?.toLowerCase(), ...user.groups].includes(d.area.toLowerCase()));

  return (
    <div className="mx-auto w-full max-w-[980px] px-5 py-6 md:px-8">
      <Link href="/proposals" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Propostas e Projetos
      </Link>
      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <span className="font-mono text-[12.5px] text-muted">{d.code}</span>
          <h1 className="text-[21px] font-semibold tracking-tight">{d.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ProposalStatusBadge status={d.status} />
            <Badge>{CLASSIFICATION_LABEL[d.classification]}</Badge>
            <Badge>{d.area}</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href={`/chat?q=${encodeURIComponent(`Resuma o escopo e os entregáveis da proposta ${d.code}`)}`}>
            <Button icon={<MessageSquare className="size-3.5" />}>Perguntar ao Minions</Button>
          </Link>
          {canEdit ? <Button icon={<Pencil className="size-3.5" />} onClick={() => setEdit(true)}>Editar</Button> : null}
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <h2 className="text-[13px] font-semibold">Escopo</h2>
            <p className="mt-2 text-[13.5px] leading-relaxed whitespace-pre-line text-fg-2">{d.scope || 'Escopo ainda não cadastrado.'}</p>
            {d.description ? (
              <>
                <h3 className="mt-5 text-[12px] font-semibold text-muted">Descrição</h3>
                <p className="mt-1 text-[13.5px] text-fg-2">{d.description}</p>
              </>
            ) : null}
            <h3 className="mt-5 text-[12px] font-semibold text-muted">Entregáveis</h3>
            {d.deliverables.length ? (
              <ul className="mt-1.5 space-y-1 text-[13.5px] text-fg-2">
                {d.deliverables.map((x) => <li key={x} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-faint" />{x}</li>)}
              </ul>
            ) : (
              <p className="mt-1 text-[13px] text-muted">Nenhum entregável cadastrado.</p>
            )}
          </Card>
          <Card>
            <div className="border-b border-line px-5 py-3 text-[13px] font-semibold">Documentos e planilhas associados</div>
            {d.documents.length ? (
              <ul className="divide-y divide-line">
                {d.documents.map((doc) => (
                  <li key={doc.id}>
                    <Link href={`/knowledge/${doc.id}`} className="flex items-center gap-3 px-5 py-3 text-[13.5px] hover:bg-surface-2/60">
                      <FileText className="size-4 text-faint" />
                      <span className="flex-1 font-medium">{doc.title}</span>
                      <Badge>{doc.category}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nenhum documento vinculado" description="Vincule documentos ao publicar na Base de Conhecimento." />
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="text-[13px] font-semibold">Informações</h2>
            <dl className="mt-3 space-y-3 text-[13px]">
              <div><dt className="text-[11.5px] text-muted">Cliente</dt><dd className="font-medium">{d.client || '—'}</dd></div>
              <div><dt className="text-[11.5px] text-muted">Data limite</dt><dd className="font-medium">{d.dueDate ? fmtDate(d.dueDate) : '—'}</dd></div>
              <div>
                <dt className="text-[11.5px] text-muted">Responsável</dt>
                <dd className="mt-1 flex items-center gap-2 font-medium">{d.ownerName ? <><Avatar name={d.ownerName} size={22} />{d.ownerName}</> : '—'}</dd>
              </div>
              <div>
                <dt className="text-[11.5px] text-muted">Equipe</dt>
                <dd className="mt-1 space-y-1.5">{d.members.length ? d.members.map((m) => <div key={m.id} className="flex items-center gap-2"><Avatar name={m.name} size={22} /><span>{m.name}</span><span className="text-muted">{m.jobTitle}</span></div>) : '—'}</dd>
              </div>
            </dl>
          </Card>
          <Card className="p-5">
            <h2 className="text-[13px] font-semibold">Histórico de atualizações</h2>
            <ol className="mt-3 space-y-2.5 border-l border-line pl-4">
              {d.history.map((h, i) => (
                <li key={i} className="relative text-[12.5px]">
                  <span className="absolute top-1.5 -left-[20.5px] size-2 rounded-full bg-line-strong" />
                  <p className="text-fg-2">{h.change}</p>
                  <p className="text-[11.5px] text-faint">{fmtDateTime(h.at)} · {h.by ?? 'Sistema'}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
      {edit ? <ProposalForm proposal={d} onClose={() => setEdit(false)} onSaved={() => void p.reload()} /> : null}
    </div>
  );
}
