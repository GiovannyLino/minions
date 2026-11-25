'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { History, MessageSquarePlus, Trash2 } from 'lucide-react';
import type { ChatAnswer, Conversation, Message, TraceEvent } from '@minions/core/contracts';
import { apiFetch, streamChat, useApi } from '@/lib/api-client';
import { cx, fmtRelative } from '@/lib/format';
import { Aurora, Orb } from '../brand';
import { useSession } from '../session';
import { Avatar, ErrorState, IconButton, Skeleton } from '../ui';
import { AgentsLive } from './agents-live';
import { AnswerView } from './answer';
import { Composer } from './composer';

interface Turn {
  id: string;
  question: string;
  answer: ChatAnswer | null;
  trace: TraceEvent[];
  error?: string;
  pending?: boolean;
}

const STARTERS = [
  'Como abrir uma solicitação de compras?',
  'Preciso preencher uma planilha de uma proposta, mas não sei qual modelo utilizar.',
  'Qual é o limite de reembolso de refeição em viagem?',
  'Preciso abrir um E-PROC, mas não sei o que é nem como fazer isso.',
];

function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === 'user') turns.push({ id: m.id, question: m.content, answer: null, trace: [] });
    else if (turns.length) turns[turns.length - 1]!.answer = m.answer;
  }
  return turns;
}

export function ChatView({ conversationId: initialId }: { conversationId: string | null }) {
  const user = useSession();
  const router = useRouter();
  const search = useSearchParams();
  const [conversationId, setConversationId] = useState<string | null>(initialId);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(Boolean(initialId));
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const conversations = useApi<Conversation[]>('/conversations');
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const busy = turns.some((t) => t.pending);

  useEffect(() => {
    if (!initialId) return;
    let cancelled = false;
    apiFetch<Message[]>(`/conversations/${initialId}/messages`)
      .then((m) => !cancelled && setTurns(toTurns(m)))
      .catch((e) => !cancelled && setHistoryError(e.message))
      .finally(() => !cancelled && setLoadingHistory(false));
    return () => {
      cancelled = true;
    };
  }, [initialId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const send = useCallback(
    async (question: string) => {
      const id = crypto.randomUUID();
      setTurns((t) => [...t, { id, question, answer: null, trace: [], pending: true }]);
      const update = (patch: Partial<Turn> | ((t: Turn) => Partial<Turn>)) => setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)));
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await streamChat(
          { message: question, conversationId },
          {
            onConversation: (cid) => {
              if (!conversationId) {
                setConversationId(cid);
                // Atualiza a URL sem remontar a página durante o streaming.
                window.history.replaceState(null, '', `/chat/${cid}`);
              }
            },
            onTrace: (e) => update((t) => ({ trace: [...t.trace, e] })),
            onAnswer: ({ answer }) => update({ answer, pending: false }),
            onError: (e) => update({ error: e.message, pending: false }),
          },
          controller.signal,
        );
      } catch (e) {
        update({ error: controller.signal.aborted ? 'Pergunta interrompida.' : 'Falha de conexão com o Minions.', pending: false });
      } finally {
        update((t) => (t.pending ? { pending: false, error: t.answer ? undefined : 'A resposta não foi concluída.' } : {}));
        void conversations.reload();
      }
    },
    [conversationId, conversations],
  );

  // Pergunta vinda do dashboard (?q=...)
  useEffect(() => {
    const q = search.get('q');
    if (q && !started.current && !initialId) {
      started.current = true;
      router.replace('/chat');
      void send(q);
    }
  }, [search, initialId, router, send]);

  const removeConversation = async (id: string) => {
    await apiFetch(`/conversations/${id}`, { method: 'DELETE' }).catch(() => undefined);
    if (id === conversationId) router.push('/chat');
    void conversations.reload();
  };

  return (
    <div className="flex h-full">
      {/* Histórico */}
      <aside className={cx('w-[264px] shrink-0 flex-col border-r border-line bg-surface/60', showHistory ? 'fixed inset-y-0 left-0 z-40 flex bg-surface shadow-pop md:static md:shadow-none' : 'hidden lg:flex')}>
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span className="px-1 text-[11.5px] font-semibold tracking-wide text-muted uppercase">Conversas</span>
          <Link href="/chat" onClick={() => setShowHistory(false)} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line bg-surface px-2 text-[12px] font-medium text-fg-2 hover:bg-surface-2">
            <MessageSquarePlus className="size-3.5" /> Nova
          </Link>
        </div>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {conversations.loading && !conversations.data ? (
            Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="mx-1 my-1.5 h-8" />)
          ) : conversations.data?.length ? (
            conversations.data.map((c) => (
              <div key={c.id} className={cx('group flex items-center rounded-lg', c.id === conversationId ? 'bg-surface-2' : 'hover:bg-surface-2/70')}>
                <Link href={`/chat/${c.id}`} className="min-w-0 flex-1 px-2.5 py-2">
                  <span className={cx('block truncate text-[13px]', c.id === conversationId ? 'font-medium text-fg' : 'text-fg-2')}>{c.title}</span>
                  <span className="block text-[11px] text-faint">{fmtRelative(c.updatedAt)}</span>
                </Link>
                <IconButton label="Excluir conversa" className="mr-1 size-7 opacity-0 group-hover:opacity-100" onClick={() => removeConversation(c.id)}>
                  <Trash2 className="size-3.5" />
                </IconButton>
              </div>
            ))
          ) : (
            <p className="px-2.5 py-4 text-[12.5px] text-muted">Suas conversas aparecerão aqui.</p>
          )}
        </div>
      </aside>
      {showHistory ? <div className="fixed inset-0 z-30 bg-black/20 lg:hidden" onClick={() => setShowHistory(false)} /> : null}

      {/* Conversa */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 lg:hidden">
          <button onClick={() => setShowHistory(true)} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] font-medium text-muted hover:bg-surface-2">
            <History className="size-4" /> Histórico
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[760px] px-4 py-6 md:px-6">
            {loadingHistory ? (
              <div className="space-y-4">
                <Skeleton className="ml-auto h-10 w-2/3" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : historyError ? (
              <ErrorState message={historyError} />
            ) : turns.length === 0 ? (
              <div className="relative isolate pt-[6vh]">
                <Aurora className="aurora-soft -z-10 -mx-20 opacity-80" />
                <div className="stagger flex flex-col items-center text-center">
                  <Orb size={84} glow />
                  <h2 className="mt-7 text-[30px] leading-tight font-semibold tracking-[-0.04em]">
                    Olá, <span className="text-gradient">{user.name.split(' ')[0]}</span>. O que você precisa saber?
                  </h2>
                  <p className="mt-2 max-w-md text-[13.5px] text-muted">Os agentes consultam somente os documentos que você tem permissão para ver e sempre mostram as fontes.</p>
                </div>
                <div className="stagger mx-auto mt-8 grid max-w-xl gap-2 sm:grid-cols-2">
                  {STARTERS.map((s) => (
                    <button key={s} onClick={() => send(s)} className="glass lift rounded-2xl px-3.5 py-3 text-left text-[13px] text-fg-2 hover:text-fg">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-8">
                {turns.map((t) => (
                  <div key={t.id} className="space-y-4">
                    <div className="flex justify-end gap-2.5">
                      <div className="bg-brand max-w-[85%] animate-fade-up rounded-2xl rounded-tr-md px-4 py-2.5 text-[14px] text-white shadow-soft">{t.question}</div>
                      <Avatar name={user.name} size={28} className="mt-1" />
                    </div>
                    <div className="flex gap-3">
                      <Orb size={28} thinking={t.pending} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        {t.answer ? (
                          <AnswerView answer={t.answer} trace={t.trace} onAsk={busy ? undefined : send} />
                        ) : t.error ? (
                          <ErrorState message={t.error} />
                        ) : (
                          <AgentsLive trace={t.trace} />
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>
        <div className="border-t border-line bg-bg/80 backdrop-blur">
          <div className="mx-auto w-full max-w-[760px] px-4 py-3 md:px-6">
            <Composer onSend={send} busy={busy} onStop={() => abortRef.current?.abort()} autoFocus />
            <p className="mt-1.5 text-center text-[11px] text-faint">O Minions responde apenas com base na base de conhecimento autorizada. Confira as fontes antes de agir.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
