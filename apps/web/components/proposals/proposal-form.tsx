'use client';

import { useState } from 'react';
import { CLASSIFICATIONS, CLASSIFICATION_LABEL, PROPOSAL_STATUSES, PROPOSAL_STATUS_LABEL, type PersonDTO, type ProposalDTO } from '@minions/core/contracts';
import { ApiClientError, apiFetch, useApi } from '@/lib/api-client';
import { useSession } from '../session';
import { Button, Drawer, ErrorState, Field, Input, Select, Textarea } from '../ui';

export function ProposalForm({ proposal, onClose, onSaved }: { proposal?: ProposalDTO; onClose: () => void; onSaved: (p: ProposalDTO) => void }) {
  const user = useSession();
  const people = useApi<PersonDTO[]>('/people');
  const [f, setF] = useState({
    code: proposal?.code ?? '',
    name: proposal?.name ?? '',
    client: proposal?.client ?? '',
    description: proposal?.description ?? '',
    scope: proposal?.scope ?? '',
    status: proposal?.status ?? 'draft',
    area: proposal?.area ?? user.area ?? '',
    classification: proposal?.classification ?? 'restricted',
    ownerPersonId: proposal?.ownerPersonId ?? '',
    memberPersonIds: proposal?.memberPersonIds ?? [],
    dueDate: proposal?.dueDate ?? '',
    deliverables: (proposal?.deliverables ?? []).join('\n'),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = JSON.stringify({
        ...f,
        ownerPersonId: f.ownerPersonId || null,
        dueDate: f.dueDate || null,
        deliverables: f.deliverables.split('\n').map((d) => d.trim()).filter(Boolean),
      });
      const out = await apiFetch<ProposalDTO>(proposal ? `/proposals/${proposal.id}` : '/proposals', { method: proposal ? 'PUT' : 'POST', body });
      onSaved(out);
      onClose();
    } catch (e) {
      setError(e instanceof ApiClientError ? (e.details ? `${e.message}: verifique os campos obrigatórios.` : e.message) : 'Falha ao salvar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open onClose={onClose} width={600} title={proposal ? `Editar ${proposal.code}` : 'Nova proposta'} subtitle="Somente dados cadastrados aqui são usados pelo Proposal Agent." footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save} disabled={!f.code || !f.name || !f.area}>Salvar</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
          <Field label="Código"><Input value={f.code} placeholder="PRP-2026-001" onChange={(e) => set('code', e.target.value.toUpperCase())} /></Field>
          <Field label="Nome"><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cliente"><Input value={f.client} onChange={(e) => set('client', e.target.value)} /></Field>
          <Field label="Status">
            <Select value={f.status} onChange={(e) => set('status', e.target.value as typeof f.status)}>{PROPOSAL_STATUSES.map((s) => <option key={s} value={s}>{PROPOSAL_STATUS_LABEL[s]}</option>)}</Select>
          </Field>
          <Field label="Área"><Input value={f.area} onChange={(e) => set('area', e.target.value)} /></Field>
          <Field label="Classificação">
            <Select value={f.classification} onChange={(e) => set('classification', e.target.value as typeof f.classification)}>{CLASSIFICATIONS.map((c) => <option key={c} value={c}>{CLASSIFICATION_LABEL[c]}</option>)}</Select>
          </Field>
          <Field label="Responsável">
            <Select value={f.ownerPersonId} onChange={(e) => set('ownerPersonId', e.target.value)}>
              <option value="">—</option>
              {people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <Field label="Data limite"><Input type="date" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></Field>
        </div>
        <Field label="Equipe" hint="Ctrl/Cmd + clique para selecionar várias pessoas">
          <select multiple value={f.memberPersonIds} onChange={(e) => set('memberPersonIds', [...e.target.selectedOptions].map((o) => o.value))} className="h-28 w-full rounded-lg border border-line bg-surface px-2 py-1 text-[13px]">
            {people.data?.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.area}</option>)}
          </select>
        </Field>
        <Field label="Descrição"><Textarea rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Escopo"><Textarea rows={5} value={f.scope} onChange={(e) => set('scope', e.target.value)} /></Field>
        <Field label="Entregáveis" hint="Um por linha"><Textarea rows={3} value={f.deliverables} onChange={(e) => set('deliverables', e.target.value)} /></Field>
        {error ? <ErrorState message={error} /> : null}
      </div>
    </Drawer>
  );
}
