'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AlertTriangle, ArrowUpRight, History, Briefcase, ChevronDown, Download, FileText, Lightbulb, ListChecks, Mail, ShieldAlert, Sparkles, Users, Workflow } from 'lucide-react';
import { AGENT_META, CLASSIFICATION_LABEL, PROPOSAL_STATUS_LABEL, type ChatAnswer, type TraceEvent } from '@minions/core/contracts';
import { AgentChip } from '../brand';
import { Avatar, Badge } from '../ui';
import { RichText, inline } from './rich-text';
import { TraceTimeline } from './agents-live';
import { apiFetch } from '@/lib/api-client';
import { cx, fmtDate } from '@/lib/format';

const STATUS = {
  answered: { label: 'Respondido com fontes', tone: 'success' as const },
  partial: { label: 'Resposta parcial', tone: 'warning' as const },
  insufficient: { label: 'Informação insuficiente', tone: 'neutral' as const },
};

export function AnswerView({ answer, trace, onAsk }: { answer: ChatAnswer; trace?: TraceEvent[]; onAsk?: (q: string) => void }) {
  const [highlight, setHighlight] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const cite = (ref: string) => {
    setHighlight(ref);
    document.getElementById(`src-${answer.traceId}-${ref}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    window.setTimeout(() => setHighlight(null), 1800);
  };
  const st = STATUS[answer.status];
  const workers = answer.agents.filter((a) => a.agent !== 'orchestrator');

  return (
    <div className="animate-fade-up space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={st.tone} dot>
          {st.label}
        </Badge>
        <Badge tone={answer.mode === 'llm' ? 'accent' : 'neutral'}>
          {answer.mode === 'llm' ? (
            <>
              <Sparkles className="size-3" /> IA local
            </>
          ) : answer.mode === 'memory' ? (
            <>
              <History className="size-3" /> Da memória · sem IA
            </>
          ) : (
            'Modo extrativo'
          )}
        </Badge>
        {answer.memory ? <span className="text-[11.5px] text-faint">resposta de {fmtDate(answer.memory.createdAt)}, fontes revalidadas</span> : null}
        <span className="text-[11.5px] text-faint">{(answer.durationMs / 1000).toFixed(1)} s</span>
      </div>

      <div className={cx('text-[14.5px] leading-[1.7] text-fg-2', answer.status === 'insufficient' && 'text-fg')}>
        <RichText text={answer.summary} onCite={cite} />
      </div>

      {answer.conflicts.length ? (
        <div className="space-y-2">
          {answer.conflicts.map((c, i) => (
            <div key={i} className="flex gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] leading-relaxed text-fg-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>
                <p className="mb-0.5 font-semibold text-warning">Documentos divergentes</p>
                {inline(c.description, cite)}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {answer.steps.length ? (
        <section>
          <SubTitle icon={<ListChecks className="size-3.5" />}>Passo a passo</SubTitle>
          <ol className="space-y-2">
            {answer.steps.map((s, i) => (
              <li key={i} className="flex gap-3 rounded-xl border border-line bg-surface px-3.5 py-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft font-mono text-[11.5px] font-semibold text-accent-text">{i + 1}</span>
                <div className="min-w-0 text-[13.5px]">
                  <p className="font-medium text-fg">{s.title}</p>
                  <p className="mt-0.5 text-muted">
                    {inline(s.detail, cite)}
                    {s.citations.map((c) => (
                      <button key={c} type="button" className="cite" onClick={() => cite(c)}>
                        {c.slice(1)}
                      </button>
                    ))}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {answer.sources.length ? (
        <section>
          <SubTitle icon={<FileText className="size-3.5" />}>Documentos utilizados</SubTitle>
          <div className="grid gap-2 sm:grid-cols-2">
            {answer.sources.map((s) => (
              <SourceCard key={s.ref} id={`src-${answer.traceId}-${s.ref}`} source={s} highlighted={highlight === s.ref} />
            ))}
          </div>
        </section>
      ) : null}

      {answer.people.length ? (
        <section>
          <SubTitle icon={<Users className="size-3.5" />}>Quem pode ajudar</SubTitle>
          <div className="grid gap-2 sm:grid-cols-2">
            {answer.people.map((p) => (
              <div key={p.id} className="flex items-start gap-3 rounded-xl border border-line bg-surface px-3.5 py-3">
                <Avatar name={p.name} size={32} />
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="font-medium text-fg">{p.name}</p>
                  <p className="truncate text-[12px] text-muted">{[p.jobTitle, p.area].filter(Boolean).join(' · ')}</p>
                  <p className="mt-1 text-[12px] text-fg-2">{p.reason}</p>
                  {p.email ? (
                    <a href={`mailto:${p.email}`} className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-accent-text hover:underline">
                      <Mail className="size-3" />
                      {p.email}
                    </a>
                  ) : (
                    <p className="mt-1.5 text-[11.5px] text-faint">Contato não disponível para exibição</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {answer.proposals.length ? (
        <section>
          <SubTitle icon={<Briefcase className="size-3.5" />}>Propostas relacionadas</SubTitle>
          <div className="flex flex-wrap gap-2">
            {answer.proposals.map((p) => (
              <Link key={p.id} href={`/proposals/${p.id}`} className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] transition-colors hover:border-line-strong">
                <span className="font-mono text-[11.5px] text-muted">{p.code}</span>
                <span className="font-medium">{p.name}</span>
                <Badge>{PROPOSAL_STATUS_LABEL[p.status as keyof typeof PROPOSAL_STATUS_LABEL] ?? p.status}</Badge>
                <ArrowUpRight className="size-3.5 text-faint" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {answer.nextActions.length || answer.suggestions.length ? (
        <section className="grid gap-4 sm:grid-cols-2">
          {answer.nextActions.length ? (
            <div>
              <SubTitle icon={<Lightbulb className="size-3.5" />}>Próximas ações</SubTitle>
              <ul className="space-y-1.5 text-[13px] text-fg-2">
                {answer.nextActions.map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" />
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {answer.suggestions.length && onAsk ? (
            <div>
              <SubTitle>Perguntas sugeridas</SubTitle>
              <div className="flex flex-col items-start gap-1.5">
                {answer.suggestions.map((s) => (
                  <button key={s} onClick={() => onAsk(s)} className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-[12.5px] text-fg-2 transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent-text">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 flex items-center gap-1 text-[11.5px] font-medium text-faint">
            <Workflow className="size-3.5" /> Agentes consultados
          </span>
          <AgentChip agent="orchestrator" />
          {workers.map((a) => (
            <span key={a.agent} title={`${AGENT_META[a.agent].name}: ${a.summary}`}>
              <AgentChip agent={a.agent} status={a.status} />
            </span>
          ))}
          {trace?.length ? (
            <button onClick={() => setShowTrace((v) => !v)} className="ml-auto inline-flex items-center gap-1 text-[12px] font-medium text-muted hover:text-fg">
              Rastreamento
              <ChevronDown className={cx('size-3.5 transition-transform', showTrace && 'rotate-180')} />
            </button>
          ) : null}
        </div>
        {showTrace && trace ? (
          <div className="mt-3 rounded-xl border border-line bg-surface-2/50 p-4">
            <TraceTimeline trace={trace} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SubTitle({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <h4 className="mb-2 flex items-center gap-1.5 text-[11.5px] font-semibold tracking-wide text-muted uppercase">
      {icon}
      {children}
    </h4>
  );
}

function SourceCard({ id, source: s, highlighted }: { id: string; source: ChatAnswer['sources'][number]; highlighted: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div id={id} className={cx('rounded-xl border bg-surface px-3.5 py-3 transition-all duration-300', highlighted ? 'border-accent shadow-[0_0_0_3px_var(--ring)]' : 'border-line')}>
      <div className="flex items-start gap-2.5">
        <span className="cite mt-0.5 !cursor-default">{s.ref.slice(1)}</span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[13px] font-medium leading-snug text-fg">{s.title}</p>
          <p className="mt-0.5 text-[11.5px] text-muted">
            v{s.version} · {fmtDate(s.updatedAt)}
            {s.page ? ` · pág. ${s.page}` : ''}
            {s.section ? ` · ${s.section}` : ''}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge>{CLASSIFICATION_LABEL[s.classification]}</Badge>
        {s.suspicious ? (
          <Badge tone="danger">
            <ShieldAlert className="size-3" /> Conteúdo suspeito
          </Badge>
        ) : null}
      </div>
      <button onClick={() => setOpen((v) => !v)} className="mt-2 flex items-center gap-1 text-[12px] font-medium text-muted hover:text-fg">
        Trecho utilizado <ChevronDown className={cx('size-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? <blockquote className="mt-1.5 border-l-2 border-line-strong pl-3 text-[12.5px] leading-relaxed whitespace-pre-line text-fg-2">{s.excerpt}</blockquote> : null}
      {s.downloadUrl ? (
        <button
          onClick={async () => {
            // Gera um link novo a cada clique (expira em 5 min e é vinculado ao usuário).
            const { url } = await apiFetch<{ url: string }>(`/documents/${s.documentId}/download-link?version=${s.versionId}`, { method: 'POST' }).catch(() => ({ url: '' }));
            if (url) window.location.href = url;
          }}
          className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-accent-text hover:underline"
        >
          <Download className="size-3" /> Abrir documento
        </button>
      ) : (
        <p className="mt-2 text-[11.5px] text-faint">Documento indisponível para você no momento</p>
      )}
    </div>
  );
}
