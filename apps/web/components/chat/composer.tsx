'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { cx } from '@/lib/format';

export function Composer({ onSend, busy, onStop, autoFocus, placeholder, large }: { onSend: (q: string) => void; busy?: boolean; onStop?: () => void; autoFocus?: boolean; placeholder?: string; large?: boolean }) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = () => {
    const q = value.trim();
    if (q.length < 2 || busy) return;
    onSend(q);
    setValue('');
  };

  return (
    <div className={cx('ring-brand group relative rounded-2xl border border-line bg-surface shadow-soft transition-all duration-300 focus-within:border-transparent focus-within:shadow-[0_0_0_6px_var(--ring),var(--shadow-lg)]', large ? 'p-2' : 'p-1.5', busy && 'is-active')}>
      <textarea
        ref={ref}
        value={value}
        rows={1}
        maxLength={4000}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder ?? 'Pergunte qualquer coisa sobre processos, documentos, propostas ou pessoas…'}
        aria-label="Sua pergunta"
        className={cx('block w-full resize-none bg-transparent px-3 pr-12 text-fg placeholder:text-faint focus:outline-none', large ? 'py-3 text-[15px]' : 'py-2.5 text-[14px]')}
      />
      <div className="absolute right-2.5 bottom-2.5">
        {busy ? (
          <button onClick={onStop} aria-label="Interromper" className="flex size-8 items-center justify-center rounded-xl bg-surface-3 text-fg transition-colors hover:bg-line-strong">
            <Square className="size-3 fill-current" />
          </button>
        ) : (
          <button onClick={submit} disabled={value.trim().length < 2} aria-label="Enviar pergunta" className="btn-brand flex size-8 items-center justify-center rounded-xl transition-all disabled:!bg-none disabled:bg-surface-3 disabled:text-faint disabled:shadow-none">
            <ArrowUp className="size-4" strokeWidth={2.2} />
          </button>
        )}
      </div>
    </div>
  );
}
