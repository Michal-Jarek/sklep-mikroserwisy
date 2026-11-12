import { Button } from '@/components/ui/button';

interface PaginationProps {
  /** Current page, counted from 1. */
  page: number;
  size: number;
  total: number;
  onPageChange: (page: number) => void;
}

/** "Poprzednia / Strona X z Y / Następna" for a page of the API (`page`, `size`, `total`). */
export function Pagination({ page, size, total, onPageChange }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Strony" className="flex items-center justify-center gap-3 py-4">
      <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        Poprzednia
      </Button>
      <span className="text-sm text-muted-foreground">
        Strona {page} z {pages}
      </span>
      <Button type="button" variant="outline" size="sm" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
        Następna
      </Button>
    </nav>
  );
}
