import { Suspense } from 'react';
import { ChatView } from '@/components/chat/chat-view';

export const metadata = { title: 'Chat' };

export default function ChatPage() {
  return (
    <Suspense>
      <ChatView conversationId={null} />
    </Suspense>
  );
}
