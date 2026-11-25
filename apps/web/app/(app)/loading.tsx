import { Skeleton } from '@/components/ui';

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1120px] space-y-4 px-5 py-8 md:px-8">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-96" />
      <Skeleton className="mt-6 h-40" />
    </div>
  );
}
