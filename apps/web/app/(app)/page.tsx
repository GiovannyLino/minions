import Link from 'next/link';
import { ArrowUpRight, BookOpen, Briefcase, FileText, MessageSquare, Users } from 'lucide-react';
import { AGENT_META, type DashboardDTO } from '@minions/core/contracts';
import { AgentDot, Aurora, Orb } from '@/components/brand';
import { AskBox } from '@/components/dashboard/ask-box';
import { DocStatusBadge } from '@/components/knowledge/status';
import { Card, EmptyState, SectionTitle, Stat } from '@/components/ui';
import { apiServer } from '@/lib/session';
import { fmtRelative } from '@/lib/format';

export const metadata = { title: 'Dashboard' };

function greeting() {
  const h = Number(new Date().toLocaleString('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }));
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

const AGENT_PROMPTS: { agent: 'knowledge' | 'process' | 'proposal' | 'people'; prompt: string }[] = [
  { agent: 'knowledge', prompt: 'O que significa a sigla RDO?' },
  { agent: 'process', prompt: 'Como abrir uma solicitação de compras?' },
  { agent: 'proposal', prompt: 'Qual é o status da proposta PRP-2025-014?' },
  { agent: 'people', prompt: 'Com quem posso falar sobre reembolso de despesas?' },
];

export default async function DashboardPage() {
  const [me, data] = await Promise.all([apiServer<{ name: string }>('/v1/me'), apiServer<DashboardDTO>('/v1/dashboard')]);
  const max = Math.max(1, ...data.activity.map((a) => a.questions + a.uploads));

  return (
    <div className="mx-auto w-full max-w-[1120px] px-5 py-8 md:px-8">
      <section className="relative isolate overflow-hidden rounded-[28px] border border-line px-6 py-9 md:px-10 md:py-12">
        <Aurora className="-z-10" />
        <div className="stagger relative flex flex-col gap-8 md:flex-row md:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-muted first-letter:uppercase">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            <h1 className="mt-2 text-[38px] leading-[1.05] font-semibold tracking-[-0.045em] md:text-[48px]">
              {greeting()}, <span className="text-gradient">{me.name.split(' ')[0]}</span>.
            </h1>
            <p className="mt-3 max-w-xl text-[15px] text-fg-2">Pergunte ao Minions — os agentes consultam a base autorizada, colaboram entre si e mostram as fontes.</p>
            <div className="mt-6 max-w-[720px]">
              <AskBox />
            </div>
          </div>
          <div className="hidden shrink-0 md:block">
            <Orb size={150} glow />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted">
          <span>Modo de resposta:</span>
          <span className="glass rounded-full px-2.5 py-0.5 font-medium text-fg-2">
            {data.aiMode === 'llm' ? `IA local (${data.aiProvider?.replace(/^ollama:/, '') ?? 'modelo'})` : 'Extrativo — sem modelo de IA'}
          </span>
          {data.offline ? <span className="rounded-full bg-success-soft px-2.5 py-0.5 font-medium text-success">● Funciona offline · custo zero</span> : null}
        </div>
      </section>

      <section className="mt-9">
        <SectionTitle>Acesso rápido aos agentes</SectionTitle>
        <div className="stagger grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {AGENT_PROMPTS.map(({ agent, prompt }) => (
            <Link key={agent} href={`/chat?q=${encodeURIComponent(prompt)}`} className="group">
              <Card interactive className="relative h-full overflow-hidden p-4">
                <span className="absolute -top-10 -right-10 size-24 rounded-full opacity-25 blur-2xl transition-opacity duration-300 group-hover:opacity-60" style={{ background: `var(--agent-${agent})` }} aria-hidden />
                <div className="relative flex items-center gap-2 text-[13px] font-semibold">
                  <AgentDot agent={agent} />
                  {AGENT_META[agent].name}
                  <ArrowUpRight className="ml-auto size-3.5 text-faint transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg" />
                </div>
                <p className="mt-1 text-[12.5px] text-muted">{AGENT_META[agent].role}</p>
                <p className="mt-3 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-fg-2">“{prompt}”</p>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section className="stagger mt-9 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Documentos disponíveis" value={data.stats.readyDocuments} hint={`${data.stats.chunks} trechos indexados`} icon={<BookOpen className="size-4 text-faint" />} />
        <Stat label="Propostas" value={data.stats.proposals} icon={<Briefcase className="size-4 text-faint" />} />
        <Stat label="Pessoas e especialistas" value={data.stats.people} icon={<Users className="size-4 text-faint" />} />
        <Stat
          label="Suas perguntas (7 dias)"
          value={data.stats.questionsLast7d}
          hint={data.stats.answeredRateLast7d == null ? 'Sem perguntas recentes' : `${Math.round(data.stats.answeredRateLast7d * 100)}% respondidas com fontes`}
          icon={<MessageSquare className="size-4 text-faint" />}
        />
      </section>

      <section className="mt-9 grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <SectionTitle action={<Link href="/knowledge" className="text-[12.5px] font-medium text-muted hover:text-fg">Ver todos</Link>}>Adicionados recentemente</SectionTitle>
          <Card>
            {data.recentDocuments.length ? (
              <ul className="divide-y divide-line">
                {data.recentDocuments.map((d) => (
                  <li key={d.id}>
                    <Link href={`/knowledge/${d.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/60">
                      <span className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface-2 text-muted">
                        <FileText className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-medium">{d.title}</p>
                        <p className="text-[12px] text-muted">
                          {d.category} · {d.area} · v{d.currentVersion || 1}
                        </p>
                      </div>
                      <DocStatusBadge status={d.status} />
                      <span className="hidden w-16 text-right text-[11.5px] text-faint sm:block">{fmtRelative(d.updatedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<BookOpen className="size-4" />} title="Nenhum documento ainda" description="Gestores podem alimentar a base em Base de Conhecimento." />
            )}
          </Card>
        </div>
        <div className="space-y-6 lg:col-span-2">
          <div>
            <SectionTitle action={<Link href="/chat" className="text-[12.5px] font-medium text-muted hover:text-fg">Nova conversa</Link>}>Últimas conversas</SectionTitle>
            <Card>
              {data.recentConversations.length ? (
                <ul className="divide-y divide-line">
                  {data.recentConversations.map((c) => (
                    <li key={c.id}>
                      <Link href={`/chat/${c.id}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2/60">
                        <MessageSquare className="size-3.5 shrink-0 text-faint" />
                        <span className="min-w-0 flex-1 truncate text-[13px]">{c.title}</span>
                        <span className="text-[11.5px] text-faint">{fmtRelative(c.updatedAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-6 text-center text-[13px] text-muted">Faça sua primeira pergunta acima.</p>
              )}
            </Card>
          </div>
          <div>
            <SectionTitle>Atividade — 14 dias</SectionTitle>
            <Card className="p-4">
              <div className="flex h-24 items-end gap-1" role="img" aria-label="Perguntas e atualizações da base por dia">
                {data.activity.map((a) => (
                  <div key={a.day} className="flex flex-1 flex-col justify-end gap-px" title={`${new Date(`${a.day}T12:00:00`).toLocaleDateString('pt-BR')}: ${a.questions} pergunta(s), ${a.uploads} atualização(ões)`}>
                    <div className="bg-brand rounded-t-sm" style={{ height: `${(a.questions / max) * 88}px` }} />
                    <div className="rounded-sm bg-[var(--agent-knowledge)]/70" style={{ height: `${(a.uploads / max) * 88}px` }} />
                    {a.questions + a.uploads === 0 ? <div className="h-px bg-line" /> : null}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-4 text-[11.5px] text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="bg-brand size-2 rounded-sm" /> Suas perguntas
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-[var(--agent-knowledge)]/70" /> Atualizações da base
                </span>
              </div>
            </Card>
          </div>
        </div>
      </section>
    </div>
  );
}
