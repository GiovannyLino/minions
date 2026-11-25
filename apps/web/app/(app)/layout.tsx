import { redirect } from 'next/navigation';
import { LogoMark } from '@/components/brand';
import { AppShell } from '@/components/shell';
import { SessionProvider, type SessionUser } from '@/components/session';
import { ApiServerError, apiPublic, apiServer, getSessionToken } from '@/lib/session';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await getSessionToken())) redirect('/login');
  // A sessão é validada na API a cada carregamento (papel/permissões sempre atualizados).
  let me: SessionUser;
  try {
    me = await apiServer<SessionUser>('/v1/me');
  } catch (err) {
    if (err instanceof ApiServerError) return <Unavailable message={err.message} />;
    throw err;
  }
  const config = await apiPublic<{ realDataAllowed: boolean }>('/v1/auth/config').catch(() => ({ realDataAllowed: false }));
  return (
    <SessionProvider user={me}>
      <AppShell realDataAllowed={config.realDataAllowed}>{children}</AppShell>
    </SessionProvider>
  );
}

function Unavailable({ message }: { message: string }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 text-center">
      <div className="max-w-sm">
        <LogoMark size={40} className="mx-auto" />
        <h1 className="mt-5 text-[18px] font-semibold">Serviço indisponível</h1>
        <p className="mt-1.5 text-[13.5px] text-muted">{message}</p>
        <a href="" className="mt-5 inline-flex h-9 items-center rounded-lg border border-line bg-surface px-4 text-[13.5px] font-medium hover:bg-surface-2">
          Tentar novamente
        </a>
      </div>
    </main>
  );
}
