'use client';

import { useRouter } from 'next/navigation';
import { Composer } from '../chat/composer';

export function AskBox() {
  const router = useRouter();
  return <Composer large autoFocus onSend={(q) => router.push(`/chat?q=${encodeURIComponent(q)}`)} placeholder="Ex.: Preciso preencher a planilha de uma proposta, qual modelo uso?" />;
}
