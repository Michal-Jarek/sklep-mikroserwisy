// Stock of one product (Inventory Service): the stock panel on the admin product page (decision 10).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/api/client';
import { ApiError } from '@/api/errors';
import { paths } from '@/api/paths';
import { productKeys } from '@/api/products';
import type { StockLevel, StockUpdateRequest } from '@/api/types';

export const inventoryKeys = {
  all: ['inventory'] as const,
  detail: (productId: string) => [...inventoryKeys.all, productId] as const,
};

/** GET /inventory/{productId}; 404 (no stock record yet) gives null instead of an error. */
export function useStock(productId: string) {
  return useQuery({
    queryKey: inventoryKeys.detail(productId),
    queryFn: async ({ signal }) => {
      try {
        return await apiRequest<StockLevel>(paths.inventory(productId), { signal });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  });
}

/** PUT /inventory/{productId} (creates the record when there is none). */
export function useUpdateStock(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: StockUpdateRequest) => apiRequest<StockLevel>(paths.inventory(productId), { method: 'PUT', body }),
    onSuccess: (stock) => {
      queryClient.setQueryData(inventoryKeys.detail(productId), stock);
      // Availability is part of the product details.
      return queryClient.invalidateQueries({ queryKey: productKeys.detail(productId) });
    },
  });
}
