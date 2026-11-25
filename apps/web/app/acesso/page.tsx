import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { Aurora, Orb } from '@/components/brand';
import { DEMO_COOKIE, codeMatches, demoCode, demoToken, isDemoTokenValid, safeNext } from '@/lib/demo-gate';

export const metadata = { title: 'Acesso' };

// Limite simples de tentativas por IP (em memória do processo).
const attempts = new Map<string, { count: number; until: number }>();

async function enter(formData: FormData) {
  'use server';
  const next = safeNext(String(formData.get('next') ?? '/'));
  const h = await headers();
  const ip = (h.get('cf-connecting-ip') ?? h.get('x-forwarded-for')?.split(',')[0] ?? 'local').trim().slice(0, 64);
  const now = Date.now();
  const entry = attempts.get(ip);
  if (entry && entry.until > now && entry.count >= 5) redirect(`/acesso?erro=bloqueado&next=${encodeURIComponent(next)}`);
  const code = String(formData.get('code') ?? '').slice(0, 200);
  if (!codeMatches(code)) {
    const fresh = !entry || entry.until < now;
    attempts.set(ip, { count: fresh ? 1 : entry.count + 1, until: fresh ? now + 10 * 60_000 : entry.until });
    if (attempts.size > 10_000) attempts.clear();
    redirect(`/acesso?erro=1&next=${encodeURIComponent(next)}`);
  }
  attempts.delete(ip);
  const secure = process.env.SESSION_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  (await cookies()).set(DEMO_COOKIE, demoToken(demoCode() ?? ''), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 7 * 86400 });
  redirect(next);
}

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ erro?: string; next?: string }> }) {
  const params = await searchParams;
  const next = safeNext(params.next);
  if (!demoCode() || isDemoTokenValid((await cookies()).get(DEMO_COOKIE)?.value)) redirect(next);

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4">
      <Aurora />
      <div className="stagger relative w-full max-w-[380px] text-center">
        <Orb size={64} glow className="mx-auto" />
        <h1 className="mt-6 text-[28px] font-semibold tracking-[-0.04em]">
          Demonstração <span className="text-gradient">Minions</span>
        </h1>
        <p className="mt-2 text-[13.5px] text-muted">Informe o código de acesso que você recebeu. Todos os dados desta demonstração são fictícios.</p>
        <form action={enter} className="glass mt-6 space-y-3 rounded-3xl p-4 text-left shadow-pop">
          <input type="hidden" name="next" value={next} />
          <label className="block text-[12.5px] font-medium text-fg-2" htmlFor="code">
            Código de acesso
          </label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <input
              id="code"
              name="code"
              type="password"
              autoComplete="off"
              autoFocus
              required
              className="h-11 w-full rounded-xl border border-line bg-surface pr-3 pl-9 text-[14px] focus:border-accent focus:ring-3 focus:ring-[var(--ring)] focus:outline-none"
            />
          </div>
          {params.erro ? (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
              {params.erro === 'bloqueado' ? 'Muitas tentativas. Aguarde alguns minutos.' : 'Código incorreto.'}
            </p>
          ) : null}
          <button className="btn-brand h-11 w-full rounded-xl text-[14px] font-medium">Entrar na demonstração</button>
        </form>
      </div>
    </main>
  );
}
