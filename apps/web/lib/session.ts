import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { callApi } from './api-transport';

export const SESSION_COOKIE = 'minions_session';
export const THEME_COOKIE = 'minions_theme';

export async function getSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

export class ApiServerError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Chamada servidor→API com o token da sessão. 401 redireciona para o login. */
export async function apiServer<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getSessionToken();
  if (!token) redirect('/login');
  const res = await callApi(path, {
    ...init,
    cache: 'no-store',
    redirect: 'error',
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, accept: 'application/json' },
  }).catch(() => {
    throw new ApiServerError(503, 'O serviço do Minions está indisponível no momento. Tente novamente em instantes.');
  });
  if (res.status === 401) redirect('/login?expired=1');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiServerError(res.status, body?.error?.message ?? `Erro ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function apiPublic<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await callApi(path, { ...init, cache: 'no-store', redirect: 'error' }).catch(() => {
    throw new ApiServerError(503, 'O serviço do Minions está indisponível no momento. Tente novamente em instantes.');
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiServerError(res.status, body?.error?.message ?? `Erro ${res.status}`);
  }
  return (await res.json()) as T;
}
