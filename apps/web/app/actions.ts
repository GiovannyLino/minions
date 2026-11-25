'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { buildEndSessionUrl } from 'openid-client';
import { DEMO_COOKIE, isDemoTokenValid } from '@/lib/demo-gate';
import { oidcConfiguration, oidcSettings } from '@/lib/oidc';
import { apiPublic, SESSION_COOKIE, THEME_COOKIE } from '@/lib/session';

const secure = process.env.SESSION_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';

/** Login de desenvolvimento: a API só o habilita com AUTH_MODE=dev fora de produção. */
export async function devLogin(formData: FormData) {
  // Ações do servidor verificam o portão da demo por conta própria (não dependem só do proxy).
  if (!isDemoTokenValid((await cookies()).get(DEMO_COOKIE)?.value)) redirect('/acesso');
  const userId = z.string().uuid().safeParse(formData.get('userId'));
  if (!userId.success) redirect('/login?error=1');
  let token: string;
  try {
    ({ token } = await apiPublic<{ token: string }>('/v1/auth/dev-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: userId.data }),
    }));
  } catch {
    redirect('/login?error=1');
  }
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 8 * 3600 });
  redirect('/');
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  // Com SSO, encerra também a sessão no IdP (senão o próximo login seria automático).
  const settings = oidcSettings();
  if (settings) {
    let endSession: string | null = null;
    try {
      const config = await oidcConfiguration(settings);
      endSession = buildEndSessionUrl(config, { client_id: settings.clientId, post_logout_redirect_uri: new URL('/login?signedOut=1', settings.appUrl).toString() }).toString();
    } catch {
      endSession = null;
    }
    if (endSession) redirect(endSession);
  }
  redirect('/login?signedOut=1');
}

export async function setTheme(theme: 'light' | 'dark' | 'system') {
  const jar = await cookies();
  jar.set(THEME_COOKIE, theme, { sameSite: 'lax', secure, path: '/', maxAge: 365 * 86400 });
}
