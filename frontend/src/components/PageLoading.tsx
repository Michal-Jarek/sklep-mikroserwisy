import { Skeleton } from '@/components/ui/skeleton';

/** Placeholder while a page or a section loads. */
export function PageLoading({ label = 'Ładowanie…' }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3 py-4">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
