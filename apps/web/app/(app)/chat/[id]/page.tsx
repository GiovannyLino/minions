import { Suspense } from 'react';
import { ChatView } from '@/components/chat/chat-view';

export const metadata = { title: 'Chat' };

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ChatView key={id} conversationId={id} />
    </Suspense>
  );
}
