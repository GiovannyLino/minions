import { ArrowRight, ShieldCheck } from 'lucide-react';
import { ROLE_LABEL, type Role } from '@minions/core/contracts';
import { Aurora, Orb } from '@/components/brand';
import { oidcSettings, safeReturnTo } from '@/lib/oidc';
import { apiPublic } from '@/lib/session';
import { devLogin } from '../actions';

export const metadata = { title: 'Entrar' };

interface DevUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  area: string | null;
}

const ERRORS: Record<string, string> = {
  sso_config: 'O login corporativo ainda não foi configurado neste ambiente (variáveis OIDC do web).',
  sso_unavailable: 'O provedor de identidade não respondeu. Tente novamente em instantes.',
  sso_expired: 'A tentativa de login expirou. Comece novamente.',
  sso_denied: 'O login foi cancelado ou negado pelo provedor de identidade.',
  sso_failed: 'Não foi possível validar o login corporativo. Tente novamente.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; expired?: string; signedOut?: string; returnTo?: string }> }) {
  const params = await searchParams;
  const ssoReady = oidcSettings() !== null;
  const returnTo = safeReturnTo(params.returnTo);
  let config: { mode: string; devLogin: boolean } | null = null;
  let users: DevUser[] = [];
  try {
    config = await apiPublic('/v1/auth/config');
    if (config?.devLogin) users = await apiPublic<DevUser[]>('/v1/auth/dev-users');
  } catch {
    config = null;
  }

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4">
      <Aurora />
      <BackgroundConstellation />
      <div className="stagger relative w-full max-w-[420px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <Orb size={72} glow />
          <h1 className="mt-7 text-[34px] leading-tight font-semibold tracking-[-0.04em]">
            Pergunte. <span className="text-gradient">Os Minions respondem.</span>
          </h1>
          <p className="mt-2.5 text-[14px] text-muted">O conhecimento da empresa, a uma pergunta de distância.</p>
        </div>

        <div className="glass rounded-3xl p-2 shadow-pop">
          {params.expired ? <p className="mx-2 mt-2 rounded-lg bg-warning-soft px-3 py-2 text-[12.5px] text-warning">Sua sessão expirou. Entre novamente.</p> : null}
          {params.error ? <p className="mx-2 mt-2 rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{ERRORS[params.error] ?? 'Não foi possível entrar. Tente novamente.'}</p> : null}
          {params.signedOut ? <p className="mx-2 mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-muted">Você saiu do Minions.</p> : null}

          {config === null ? (
            <p className="p-4 text-center text-[13px] text-muted">A API do Minions não está respondendo. Inicie-a com <code className="font-mono">npm run dev</code>.</p>
          ) : config.devLogin ? (
            <>
              <p className="px-3 pt-3 pb-2 text-[11.5px] font-semibold tracking-wide text-muted uppercase">Ambiente de desenvolvimento · usuários fictícios</p>
              <div className="space-y-1">
                {users.map((u) => (
                  <form key={u.id} action={devLogin}>
                    <input type="hidden" name="userId" value={u.id} />
                    <button className="group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-all duration-200 hover:translate-x-0.5 hover:bg-surface-2/80">
                      <span className="flex size-8 items-center justify-center rounded-full bg-surface-3 text-[12px] font-semibold text-fg-2">
                        {u.name
                          .split(' ')
                          .map((p) => p[0])
                          .slice(0, 2)
                          .join('')}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium">{u.name}</span>
                        <span className="block truncate text-[12px] text-muted">
                          {ROLE_LABEL[u.role]} · {u.area}
                        </span>
                      </span>
                      <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
                    </button>
                  </form>
                ))}
              </div>
            </>
          ) : (
            <div className="p-3">
              {ssoReady ? (
                <a
                  href={`/auth/login${returnTo !== '/' ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`}
                  className="btn-brand flex h-11 w-full items-center justify-center gap-2.5 rounded-2xl text-[14px] font-medium"
                >
                  <MicrosoftMark />
                  Entrar com a conta corporativa
                </a>
              ) : (
                <p className="p-2 text-center text-[13px] text-muted">O login corporativo ainda não foi configurado no web. Veja docs/DEPLOY.md, seção “Entra ID”.</p>
              )}
              <p className="mt-3 text-center text-[12px] text-faint">Autenticação via Microsoft Entra ID · seu papel e grupos vêm do diretório da empresa</p>
            </div>
          )}
        </div>

        <p className="mt-6 flex items-center justify-center gap-1.5 text-[12px] text-faint">
          <ShieldCheck className="size-3.5" />
          Acesso auditado · permissões aplicadas em cada resposta
        </p>
      </div>
    </main>
  );
}

function MicrosoftMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

function BackgroundConstellation() {
  const nodes = [
    [12, 18], [28, 9], [44, 22], [63, 12], [82, 20], [90, 44], [74, 58], [57, 46], [38, 62], [20, 52], [8, 78], [33, 86], [60, 80], [86, 84],
  ];
  const edges: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 2], [7, 8], [8, 9], [9, 0], [9, 10], [10, 11], [11, 8], [11, 12], [12, 6], [12, 13], [13, 5]];
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.3]" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <g stroke="var(--border-strong)" strokeWidth="0.12">
        {edges.map(([a, b], i) => (
          <line key={i} x1={nodes[a]![0]} y1={nodes[a]![1]} x2={nodes[b]![0]} y2={nodes[b]![1]} />
        ))}
      </g>
      {nodes.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i % 4 === 0 ? 0.7 : 0.42} fill={i % 4 === 0 ? 'var(--accent)' : 'var(--faint)'} opacity={i % 4 === 0 ? 0.7 : 0.6} />
      ))}
    </svg>
  );
}
