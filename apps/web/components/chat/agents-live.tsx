'use client';

import { AGENT_META, type AgentId, type TraceEvent } from '@minions/core/contracts';
import { Check, CircleSlash, Loader2, X } from 'lucide-react';
import { AgentDot, agentColor } from '../brand';
import { cx } from '@/lib/format';

export type AgentLiveState = 'idle' | 'working' | 'done' | 'empty' | 'skipped' | 'failed';
const WORKERS: AgentId[] = ['knowledge', 'process', 'proposal', 'people'];

export function deriveAgentStates(trace: TraceEvent[]): Record<AgentId, AgentLiveState> {
  const s: Record<AgentId, AgentLiveState> = { orchestrator: 'working', knowledge: 'idle', process: 'idle', proposal: 'idle', people: 'idle' };
  for (const e of trace) {
    if (!e.agent) continue;
    if (e.type === 'agent_start') s[e.agent] = 'working';
    else if (e.type === 'agent_end') s[e.agent] = (e.data?.status as string) === 'empty' ? 'empty' : (e.data?.status as string) === 'failed' ? 'failed' : 'done';
    else if (e.type === 'agent_skipped' && s[e.agent] === 'idle') s[e.agent] = 'skipped';
    else if (e.type === 'done') s.orchestrator = 'done';
  }
  return s;
}

export function phaseLabel(trace: TraceEvent[]): string {
  const last = trace.at(-1);
  if (!last) return 'Entendendo sua pergunta…';
  if (last.type === 'synthesis') return 'Reunindo a colaboração dos agentes…';
  if (last.type === 'agent_request') return 'Agentes colaborando entre si…';
  if (trace.some((t) => t.type === 'agent_start')) return 'Consultando a base de conhecimento…';
  return 'Planejando quais agentes acionar…';
}

/**
 * Visualização ao vivo: Orchestrator no centro, quatro agentes ao redor. Linhas animadas
 * indicam quem está trabalhando; ao lado, a linha do tempo rastreável dos eventos.
 */
export function AgentsLive({ trace }: { trace: TraceEvent[] }) {
  const states = deriveAgentStates(trace);
  const pos: Record<string, [number, number]> = { knowledge: [22, 22], process: [98, 22], proposal: [98, 78], people: [22, 78] };
  return (
    <div className="glass ring-brand is-active animate-fade-up rounded-2xl p-4 shadow-soft">
      <div className="flex items-center gap-2 text-[13px] font-medium text-fg-2">
        <Loader2 className="size-3.5 animate-spin text-accent" />
        {phaseLabel(trace)}
      </div>
      <div className="mt-3 flex flex-col gap-4 sm:flex-row">
        <svg viewBox="0 0 120 100" className="h-[110px] w-full shrink-0 sm:w-[150px]" aria-hidden>
          {WORKERS.map((a) => {
            const [x, y] = pos[a]!;
            const st = states[a];
            return (
              <line key={a} x1="60" y1="50" x2={x} y2={y} stroke={st === 'idle' || st === 'skipped' ? 'var(--border)' : agentColor(a)} strokeWidth="1.2" strokeOpacity={st === 'working' ? 0.9 : 0.5} className={st === 'working' ? 'animate-draw' : undefined} />
            );
          })}
          {WORKERS.map((a) => {
            const [x, y] = pos[a]!;
            const st = states[a];
            return (
              <g key={a}>
                <circle cx={x} cy={y} r="8" fill="var(--surface)" stroke={st === 'idle' ? 'var(--border-strong)' : agentColor(a)} strokeWidth="1.4" opacity={st === 'skipped' ? 0.4 : 1} />
                <circle cx={x} cy={y} r="3" fill={st === 'idle' ? 'var(--faint)' : agentColor(a)} className={st === 'working' ? 'animate-pulse-dot' : undefined} style={{ transformBox: 'fill-box', transformOrigin: 'center' }} />
              </g>
            );
          })}
          <defs>
            <linearGradient id="mn-live-grad" x1="48" y1="38" x2="72" y2="62" gradientUnits="userSpaceOnUse">
              <stop stopColor="var(--grad-a)" />
              <stop offset="0.6" stopColor="var(--grad-b)" />
              <stop offset="1" stopColor="var(--grad-c)" />
            </linearGradient>
          </defs>
          <circle cx="60" cy="50" r="12" fill="url(#mn-live-grad)" />
          <circle cx="60" cy="50" r="4" fill="#fff" className="animate-pulse-dot" style={{ transformBox: 'fill-box', transformOrigin: 'center' }} />
        </svg>
        <ol className="min-w-0 flex-1 space-y-1.5">
          {trace
            .filter((t) => t.type !== 'done')
            .slice(-6)
            .map((t, i) => (
              <li key={`${t.at}-${i}`} className="flex animate-fade-up items-start gap-2 text-[12.5px]">
                <span className="mt-1.5">{t.agent ? <AgentDot agent={t.agent} size={6} /> : null}</span>
                <span className="min-w-0">
                  <span className="font-medium text-fg-2">{t.agent ? AGENT_META[t.agent].name : 'Sistema'}</span>
                  <span className="text-muted"> — {t.message}</span>
                </span>
              </li>
            ))}
        </ol>
      </div>
    </div>
  );
}

export function TraceTimeline({ trace }: { trace: TraceEvent[] }) {
  const icon = (t: TraceEvent) =>
    t.type === 'agent_end' ? <Check className="size-3 text-success" /> : t.type === 'agent_skipped' ? <CircleSlash className="size-3 text-faint" /> : t.type === 'error' ? <X className="size-3 text-danger" /> : null;
  return (
    <ol className="relative space-y-2 border-l border-line pl-4">
      {trace.map((t, i) => (
        <li key={i} className="relative text-[12.5px]">
          <span className={cx('absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-surface')} style={{ background: t.agent ? agentColor(t.agent) : 'var(--faint)' }} />
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-fg-2">{t.agent ? AGENT_META[t.agent].name : 'Sistema'}</span>
            {icon(t)}
            <span className="ml-auto font-mono text-[10.5px] text-faint">{new Date(t.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          </div>
          <p className="text-muted">{t.message}</p>
        </li>
      ))}
    </ol>
  );
}
