'use client';

import { useState } from 'react';
import { Plus, RotateCw, Trash2 } from 'lucide-react';
import { AGENT_META, CLASSIFICATIONS, CLASSIFICATION_LABEL, ROLES, ROLE_LABEL, type AgentSettings, type AuditEntry, type CategoryDTO, type User } from '@minions/core/contracts';
import { AgentDot } from '@/components/brand';
import { useSession } from '@/components/session';
import { PageHeader } from '@/components/shell';
import { Badge, Button, Card, EmptyState, ErrorState, Field, IconButton, Input, Select, Skeleton, Tabs } from '@/components/ui';
import { ApiClientError, apiFetch, useApi } from '@/lib/api-client';
import { fmtDateTime } from '@/lib/format';

type Tab = 'status' | 'users' | 'agents' | 'categories' | 'ingestion' | 'audit';

export default function AdminPage() {
  const user = useSession();
  const isAdmin = user.role === 'admin';
  const tabs: { value: Tab; label: string }[] = [
    ...(isAdmin ? [{ value: 'status' as const, label: 'Visão geral' }, { value: 'users' as const, label: 'Usuários e permissões' }, { value: 'agents' as const, label: 'Agentes' }] : []),
    { value: 'categories', label: 'Categorias' },
    { value: 'ingestion', label: 'Erros de processamento' },
    ...(isAdmin ? [{ value: 'audit' as const, label: 'Auditoria' }] : []),
  ];
  const [tab, setTab] = useState<Tab>(tabs[0]!.value);

  return (
    <>
      <PageHeader title="Administração" description="Usuários, permissões, base de conhecimento, agentes e trilha de auditoria." />
      <div className="px-5 md:px-8">
        <Tabs value={tab} onChange={setTab} items={tabs} />
      </div>
      <div className="px-5 py-5 md:px-8">
        {tab === 'status' && <StatusTab />}
        {tab === 'users' && <UsersTab />}
        {tab === 'agents' && <AgentsTab />}
        {tab === 'categories' && <CategoriesTab />}
        {tab === 'ingestion' && <IngestionTab />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </>
  );
}

function StatusTab() {
  const s = useApi<{ environment: string; authMode: string; database: string; llm: { provider: string; model: string } | null; embeddings: { provider: string; dim: number }; malwareScanner: string; realDataAllowed: boolean; offline: boolean; memory: { entries: number; hits: number }; queue: Record<string, number> }>('/admin/status');
  const [clearing, setClearing] = useState(false);
  if (s.error) return <ErrorState message={s.error.message} />;
  if (!s.data) return <Skeleton className="h-40" />;
  const d = s.data;
  const rows: [string, string, 'success' | 'warning' | 'neutral'][] = [
    ['Ambiente', d.environment, 'neutral'],
    ['Autenticação', d.authMode === 'oidc' ? 'OIDC (corporativa)' : 'Desenvolvimento (usuários fictícios)', d.authMode === 'oidc' ? 'success' : 'warning'],
    ['Banco de dados', d.database === 'pg' ? 'PostgreSQL' : 'PGlite embutido (dev)', d.database === 'pg' ? 'success' : 'warning'],
    ['Modelo de IA', d.llm ? `${d.llm.provider} · ${d.llm.model}` : 'Nenhum — modo extrativo', d.llm ? 'success' : 'neutral'],
    ['Embeddings', `${d.embeddings.provider} (${d.embeddings.dim} dim.)${d.embeddings.provider === 'hash' ? ' — lexical, apenas dev' : ''}`, d.embeddings.provider === 'hash' ? 'warning' : 'success'],
    ['Antivírus', d.malwareScanner === 'none' ? 'Desabilitado' : d.malwareScanner, d.malwareScanner === 'none' ? 'warning' : 'success'],
    ['Dados reais', d.realDataAllowed ? 'Permitidos' : 'Bloqueados (somente fictícios)', d.realDataAllowed ? 'success' : 'neutral'],
    ['Funciona offline', d.offline ? 'Sim — IA e busca rodam localmente, custo zero' : 'Não — depende de serviço externo', d.offline ? 'success' : 'warning'],
    ['Memória de respostas', `${d.memory.entries} resposta(s) guardada(s) · ${d.memory.hits} reaproveitamento(s)`, 'neutral'],
    ['Fila de ingestão', Object.entries(d.queue).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'vazia', 'neutral'],
  ];
  return (
    <Card>
      <ul className="divide-y divide-line">
        {rows.map(([k, v, tone]) => (
          <li key={k} className="flex items-center justify-between gap-4 px-5 py-3 text-[13px]">
            <span className="text-muted">{k}</span>
            <Badge tone={tone}>{v}</Badge>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-4 border-t border-line px-5 py-3 text-[12.5px] text-muted">
        <span>Limpar a memória força novas respostas (ex.: após revisar muitos documentos).</span>
        <Button
          size="sm"
          variant="danger"
          loading={clearing}
          disabled={!d.memory.entries}
          onClick={async () => {
            if (!window.confirm('Apagar todas as respostas guardadas na memória?')) return;
            setClearing(true);
            await apiFetch('/admin/memory', { method: 'DELETE' }).catch(() => undefined);
            setClearing(false);
            void s.reload();
          }}
        >
          Limpar memória
        </Button>
      </div>
    </Card>
  );
}

function UsersTab() {
  const me = useSession();
  const users = useApi<User[]>('/admin/users');
  const [error, setError] = useState<string | null>(null);
  const update = async (id: string, patch: Partial<User>) => {
    setError(null);
    try {
      const u = await apiFetch<User>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      users.setData(users.data!.map((x) => (x.id === id ? u : x)));
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Falha ao atualizar');
    }
  };
  if (users.error) return <ErrorState message={users.error.message} />;
  return (
    <div className="space-y-3">
      {error ? <ErrorState message={error} /> : null}
      <p className="text-[12.5px] text-muted">Papel, habilitação e grupos valem imediatamente — inclusive para o que os agentes podem consultar. Com Entra ID, papel e grupos vêm do IdP.</p>
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-[13px]">
          <thead className="border-b border-line bg-surface-2/50 text-left text-[11.5px] font-semibold tracking-wide text-muted uppercase">
            <tr><th className="px-4 py-2">Usuário</th><th className="px-4 py-2">Papel</th><th className="px-4 py-2">Habilitação</th><th className="px-4 py-2">Grupos</th><th className="px-4 py-2">Último acesso</th><th className="px-4 py-2">Ativo</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.data?.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-2.5"><p className="font-medium">{u.name}</p><p className="text-[12px] text-muted">{u.email}</p></td>
                <td className="px-4 py-2.5">
                  <Select value={u.role} disabled={u.id === me.id} onChange={(e) => update(u.id, { role: e.target.value as User['role'] })} className="h-8 w-40">{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select>
                </td>
                <td className="px-4 py-2.5">
                  <Select value={u.clearance} onChange={(e) => update(u.id, { clearance: e.target.value as User['clearance'] })} className="h-8 w-36">{CLASSIFICATIONS.map((c) => <option key={c} value={c}>{CLASSIFICATION_LABEL[c]}</option>)}</Select>
                </td>
                <td className="px-4 py-2.5">
                  <Input defaultValue={u.groups.join(', ')} className="h-8 w-44" onBlur={(e) => { const groups = e.target.value.split(',').map((g) => g.trim().toLowerCase()).filter(Boolean); if (groups.join() !== u.groups.join()) void update(u.id, { groups }); }} />
                </td>
                <td className="px-4 py-2.5 text-[12px] text-muted">{fmtDateTime(u.lastLoginAt)}</td>
                <td className="px-4 py-2.5"><input type="checkbox" checked={u.active} disabled={u.id === me.id} onChange={(e) => update(u.id, { active: e.target.checked })} className="size-4 accent-[var(--accent)]" aria-label="Ativo" /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!users.data ? <div className="p-4"><Skeleton className="h-24" /></div> : null}
      </Card>
    </div>
  );
}

function AgentsTab() {
  const s = useApi<AgentSettings>('/admin/settings/agents');
  const [draft, setDraft] = useState<AgentSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = draft ?? s.data;
  if (s.error) return <ErrorState message={s.error.message} />;
  if (!v) return <Skeleton className="h-60" />;
  const set = <K extends keyof AgentSettings>(k: K, val: AgentSettings[K]) => { setDraft({ ...v, [k]: val }); setSaved(false); };
  const save = async () => {
    setError(null);
    try {
      s.setData(await apiFetch<AgentSettings>('/admin/settings/agents', { method: 'PUT', body: JSON.stringify(v) }));
      setDraft(null);
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Falha ao salvar');
    }
  };
  const num = (k: 'maxAgentCalls' | 'maxDepth' | 'maxLlmCalls' | 'timeoutMs' | 'retrievalTopK', label: string, hint: string) => (
    <Field label={label} hint={hint}><Input type="number" value={v[k]} onChange={(e) => set(k, Number(e.target.value))} /></Field>
  );
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="p-5">
        <h3 className="text-[13px] font-semibold">Agentes habilitados</h3>
        <p className="mt-1 text-[12.5px] text-muted">O Orchestrator está sempre ativo e decide quais destes acionar.</p>
        <div className="mt-4 space-y-2">
          {(['knowledge', 'process', 'proposal', 'people'] as const).map((a) => (
            <label key={a} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={v.enabledAgents.includes(a)} onChange={(e) => set('enabledAgents', e.target.checked ? [...v.enabledAgents, a] : v.enabledAgents.filter((x) => x !== a))} />
              <AgentDot agent={a} />
              <span className="flex-1"><span className="block text-[13px] font-medium">{AGENT_META[a].name}</span><span className="block text-[12px] text-muted">{AGENT_META[a].role}</span></span>
            </label>
          ))}
        </div>
      </Card>
      <Card className="space-y-4 p-5">
        <h3 className="text-[13px] font-semibold">Limites de execução</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {num('maxAgentCalls', 'Máx. chamadas de agentes', 'Por pergunta')}
          {num('maxDepth', 'Profundidade de colaboração', 'Ondas de pedidos entre agentes')}
          {num('maxLlmCalls', 'Máx. chamadas ao modelo', 'Por pergunta')}
          {num('timeoutMs', 'Tempo máximo (ms)', 'Por pergunta')}
          {num('retrievalTopK', 'Trechos por busca', 'Top-K da busca híbrida')}
          <Field label="Relevância mínima" hint="0–1. Abaixo disso o trecho não é usado"><Input type="number" step="0.01" value={v.minRelevance} onChange={(e) => set('minRelevance', Number(e.target.value))} /></Field>
        </div>
        <h3 className="pt-2 text-[13px] font-semibold">Memória de respostas</h3>
        <p className="text-[12.5px] text-muted">Perguntas repetidas são respondidas sem IA, revalidando versões dos documentos e permissões do usuário.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Escopo" hint="Organização compartilha apenas perguntas sem contexto de conversa">
            <Select value={v.answerMemory} onChange={(e) => set('answerMemory', e.target.value as AgentSettings['answerMemory'])}>
              <option value="user">Por usuário (recomendado)</option>
              <option value="organization">Toda a organização</option>
              <option value="off">Desligada</option>
            </Select>
          </Field>
          <Field label="Similaridade mínima" hint="0,80–1. Quanto maior, mais parecida a pergunta precisa ser"><Input type="number" step="0.01" min={0.8} max={1} value={v.memorySimilarity} onChange={(e) => set('memorySimilarity', Number(e.target.value))} /></Field>
        </div>
        {error ? <ErrorState message={error} /> : null}
        <div className="flex items-center justify-end gap-3">
          {saved ? <span className="text-[12.5px] text-success">Configuração salva</span> : null}
          <Button variant="primary" onClick={save} disabled={!draft}>Salvar</Button>
        </div>
      </Card>
    </div>
  );
}

function CategoriesTab() {
  const user = useSession();
  const cats = useApi<CategoryDTO[]>('/admin/categories');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      await apiFetch('/admin/categories', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      void cats.reload();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Falha');
    }
  };
  const remove = async (id: string) => {
    setError(null);
    try {
      await apiFetch(`/admin/categories/${id}`, { method: 'DELETE' });
      void cats.reload();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Falha');
    }
  };
  return (
    <div className="max-w-2xl space-y-3">
      {user.can('admin:categories') ? (
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nova categoria" aria-label="Nova categoria" />
          <Button icon={<Plus className="size-4" />} onClick={add} disabled={name.trim().length < 2}>Adicionar</Button>
        </div>
      ) : null}
      {error ? <ErrorState message={error} /> : null}
      <Card>
        <ul className="divide-y divide-line">
          {cats.data?.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="flex-1"><span className="font-medium">{c.name}</span>{c.description ? <span className="ml-2 text-muted">{c.description}</span> : null}</span>
              <Badge>{c.documentCount} doc.</Badge>
              <IconButton label="Remover categoria" disabled={c.documentCount > 0} onClick={() => remove(c.id)}><Trash2 className="size-3.5" /></IconButton>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function IngestionTab() {
  const errs = useApi<{ documentId: string; title: string; version: number; fileName: string; error: string | null; attempts: number; at: string }[]>('/admin/ingestion/errors');
  if (errs.error) return <ErrorState message={errs.error.message} />;
  if (!errs.data) return <Skeleton className="h-32" />;
  if (!errs.data.length) return <Card><EmptyState title="Nenhum erro de processamento" description="Todos os documentos enviados foram indexados." /></Card>;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {errs.data.map((e) => (
          <li key={`${e.documentId}-${e.version}`} className="flex items-start gap-3 px-4 py-3 text-[13px]">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{e.title} <span className="font-normal text-muted">v{e.version} · {e.fileName}</span></p>
              <p className="text-danger">{e.error}</p>
              <p className="text-[12px] text-faint">{fmtDateTime(e.at)} · {e.attempts} tentativa(s)</p>
            </div>
            <Button size="sm" icon={<RotateCw className="size-3.5" />} onClick={async () => { await apiFetch(`/admin/ingestion/${e.documentId}/retry`, { method: 'POST' }); void errs.reload(); }}>Reprocessar</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AuditTab() {
  const [action, setAction] = useState('');
  const log = useApi<AuditEntry[]>(`/admin/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`);
  return (
    <div className="space-y-3">
      <Select value={action} onChange={(e) => setAction(e.target.value)} className="w-60" aria-label="Filtrar ação">
        <option value="">Todas as ações</option>
        <option value="chat.">Perguntas ao chat</option>
        <option value="document.">Documentos</option>
        <option value="auth.">Autenticação</option>
        <option value="user.">Usuários</option>
        <option value="settings.">Configurações</option>
        <option value="proposal.">Propostas</option>
        <option value="person.">Pessoas</option>
      </Select>
      {log.error ? <ErrorState message={log.error.message} /> : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[12.5px]">
            <thead className="border-b border-line bg-surface-2/50 text-left text-[11.5px] font-semibold tracking-wide text-muted uppercase">
              <tr><th className="px-4 py-2">Quando</th><th className="px-4 py-2">Quem</th><th className="px-4 py-2">Ação</th><th className="px-4 py-2">Resultado</th><th className="px-4 py-2">Detalhes</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {log.data?.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2 whitespace-nowrap text-muted">{fmtDateTime(a.at)}</td>
                  <td className="px-4 py-2">{a.actorName ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-[11.5px]">{a.action}</td>
                  <td className="px-4 py-2"><Badge tone={a.outcome === 'success' ? 'success' : a.outcome === 'denied' ? 'warning' : 'danger'}>{a.outcome === 'success' ? 'Sucesso' : a.outcome === 'denied' ? 'Negado' : 'Erro'}</Badge></td>
                  <td className="max-w-[320px] truncate px-4 py-2 font-mono text-[11px] text-muted" title={JSON.stringify(a.metadata)}>{Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!log.data ? <div className="p-4"><Skeleton className="h-24" /></div> : null}
        </Card>
      )}
    </div>
  );
}
