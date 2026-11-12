// Product management in the admin panel (Product Service, ADMIN only).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/api/client';
import { paths } from '@/api/paths';
import { productKeys } from '@/api/products';
import type { ProductDetail, ProductRequest } from '@/api/types';

/** POST /products → 201 with the details of the new product. */
export function useCreateProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProductRequest) => apiRequest<ProductDetail>(paths.products.list, { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: productKeys.all }),
  });
}

/** PUT /products/{productId} with the whole product. */
export function useUpdateProduct(productId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProductRequest) => apiRequest<ProductDetail>(paths.products.detail(productId), { method: 'PUT', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: productKeys.all }),
  });
}

/** DELETE /products/{productId} → 204. */
export function useDeleteProduct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (productId: string) => apiRequest<void>(paths.products.detail(productId), { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: productKeys.all }),
  });
}
