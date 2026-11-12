// Product categories (Product Service).
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/api/client';
import { paths } from '@/api/paths';
import type { Category } from '@/api/types';

export const categoryKeys = {
  all: ['categories'] as const,
};

/** GET /categories (alphabetical). Categories rarely change, so they stay fresh for 5 minutes. */
export function useCategories() {
  return useQuery({
    queryKey: categoryKeys.all,
    queryFn: ({ signal }) => apiRequest<Category[]>(paths.categories, { signal }),
    staleTime: 5 * 60 * 1000,
  });
}
