// Product catalogue (Product Service). Wave 2 (T4, T5) adds more hooks here or in their own files.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/api/client';
import { paths } from '@/api/paths';
import type { Page, ProductDetail, ProductListQuery, ProductSummary } from '@/api/types';

export const productKeys = {
  all: ['products'] as const,
  lists: () => [...productKeys.all, 'list'] as const,
  list: (params: ProductListQuery) => [...productKeys.lists(), params] as const,
  details: () => [...productKeys.all, 'detail'] as const,
  detail: (productId: string) => [...productKeys.details(), productId] as const,
};

/** GET /products with filters and paging; the previous page stays visible while the next one loads. */
export function useProducts(params: ProductListQuery) {
  return useQuery({
    queryKey: productKeys.list(params),
    queryFn: ({ signal }) => apiRequest<Page<ProductSummary>>(paths.products.list, { query: params, signal }),
    placeholderData: keepPreviousData,
  });
}

/** GET /products/{productId}: details with rating and availability (both may be null). */
export function useProduct(productId: string) {
  return useQuery({
    queryKey: productKeys.detail(productId),
    queryFn: ({ signal }) => apiRequest<ProductDetail>(paths.products.detail(productId), { signal }),
  });
}
