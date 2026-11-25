import type { AgentId } from '@minions/core/contracts';
import { AGENT_META } from '@minions/core/contracts';
import { cx } from '@/lib/format';

/**
 * Símbolo do Minions: um nó central (Orchestrator) conectado a quatro satélites (agentes),
 * sobre o gradiente da marca. Constelação geométrica original — sem referência a personagens.
 */
export function LogoMark({ size = 24, className, animated }: { size?: number; className?: string; animated?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <defs>
        <linearGradient id="mn-logo-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--grad-a)" />
          <stop offset="0.55" stopColor="var(--grad-b)" />
          <stop offset="1" stopColor="var(--grad-c)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="10" fill="url(#mn-logo-grad)" />
      <g className={animated ? 'animate-orbit' : undefined} style={{ transformBox: 'fill-box' }}>
        <g stroke="#fff" strokeOpacity="0.55" strokeWidth="1.2">
          <path d="M16 16 9.5 9.5M16 16l6.5-6.5M16 16l6.5 6.5M16 16l-6.5 6.5" />
        </g>
        <circle cx="9.5" cy="9.5" r="2.2" fill="#fff" fillOpacity="0.95" />
        <circle cx="22.5" cy="9.5" r="2.2" fill="#fff" fillOpacity="0.8" />
        <circle cx="22.5" cy="22.5" r="2.2" fill="#fff" fillOpacity="0.95" />
        <circle cx="9.5" cy="22.5" r="2.2" fill="#fff" fillOpacity="0.8" />
      </g>
      <circle cx="16" cy="16" r="3.8" fill="#fff" />
      <circle cx="16" cy="16" r="1.7" fill="var(--grad-b)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx('flex items-center gap-2.5', className)}>
      <LogoMark size={28} />
      <span className="text-[16px] font-semibold tracking-[-0.03em]">minions</span>
    </span>
  );
}

/** Fundo "aurora": manchas de luz em movimento lento, só CSS (sem imagens, funciona offline). */
export function Aurora({ className }: { className?: string }) {
  return (
    <div className={cx('aurora', className)} aria-hidden>
      <span />
      <span />
      <span />
    </div>
  );
}

/** Orbe animado que representa o Orchestrator; acelera quando os agentes estão trabalhando. */
export function Orb({ size = 28, thinking, glow, className }: { size?: number; thinking?: boolean; glow?: boolean; className?: string }) {
  return <span className={cx('orb inline-block shrink-0', thinking && 'is-thinking', glow && 'orb-glow', className)} style={{ width: size, height: size }} aria-hidden />;
}

export const agentColor = (id: AgentId) => `var(--agent-${id})`;

export function AgentDot({ agent, pulsing, size = 8 }: { agent: AgentId; pulsing?: boolean; size?: number }) {
  return <span className={cx('inline-block shrink-0 rounded-full', pulsing && 'animate-pulse-dot')} style={{ width: size, height: size, background: agentColor(agent) }} aria-hidden />;
}

export function AgentChip({ agent, status }: { agent: AgentId; status?: 'ok' | 'empty' | 'failed' | 'skipped' }) {
  const meta = AGENT_META[agent];
  return (
    <span
      className={cx('inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-surface px-2 text-[11.5px] font-medium text-fg-2', status === 'empty' && 'opacity-60', status === 'failed' && 'border-danger/30 text-danger')}
      title={meta.role}
    >
      <AgentDot agent={agent} size={6} />
      {meta.name}
    </span>
  );
}
