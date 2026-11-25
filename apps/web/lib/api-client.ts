'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAnswer, TraceEvent } from '@minions/core/contracts';

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Fetch do navegador → BFF (/api/v1/*). O navegador nunca fala com a API diretamente nem carrega tokens. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { ...(init.body && !isForm ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  if (res.status === 401) {
    window.location.href = '/login?expired=1';
    throw new ApiClientError(401, 'unauthorized', 'Sessão expirada');
  }
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    throw new ApiClientError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? `Erro ${res.status}`, body?.error?.details);
  }
  return body as T;
}

export interface ApiState<T> {
  data: T | undefined;
  error: ApiClientError | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (d: T) => void;
}

/** Hook mínimo de leitura com estados de carregamento/erro (sem dependências externas). */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await apiFetch<T>(path);
      if (id === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError(e instanceof ApiClientError ? e : new ApiClientError(0, 'network', 'Falha de conexão com o servidor'));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

export interface ChatStreamHandlers {
  onConversation?: (id: string) => void;
  onTrace?: (e: TraceEvent) => void;
  onAnswer?: (a: { messageId: string; answer: ChatAnswer }) => void;
  onError?: (e: { code: string; message: string }) => void;
}

/** Envia uma pergunta e consome o stream SSE (conversation → trace* → answer | error). */
export async function streamChat(body: { message: string; conversationId?: string | null }, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<void> {
  const res = await fetch('/api/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => null);
    handlers.onError?.({ code: err?.error?.code ?? 'error', message: err?.error?.message ?? `Erro ${res.status}` });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: ?(.*)$/m.exec(block)?.[1];
      const data = /^data: ?(.*)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      const parsed = JSON.parse(data);
      if (event === 'conversation') handlers.onConversation?.(parsed.id);
      else if (event === 'trace') handlers.onTrace?.(parsed);
      else if (event === 'answer') handlers.onAnswer?.(parsed);
      else if (event === 'error') handlers.onError?.(parsed);
    }
  }
}
