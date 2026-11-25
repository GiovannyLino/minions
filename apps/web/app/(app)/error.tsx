'use client';

import { ErrorState } from '@/components/ui';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-2xl px-5 py-10">
      <ErrorState message={error.message || 'Algo deu errado ao carregar esta página.'} onRetry={reset} />
    </div>
  );
}
