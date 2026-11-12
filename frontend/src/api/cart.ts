// Cart of the logged-in customer (Cart Service). Reading (header, /cart, checkout) and changes.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/api/client';
import { paths } from '@/api/paths';
import type { AddCartItemRequest, Cart, CartMutationResponse } from '@/api/types';
import { useSession } from '@/auth/session';

export const cartKeys = {
  all: ['cart'] as const,
};

/** GET /cart, only when logged in (an anonymous visitor never calls it). */
export function useCart() {
  const { status } = useSession();
  return useQuery({
    queryKey: cartKeys.all,
    queryFn: ({ signal }) => apiRequest<Cart>(paths.cart.root, { signal }),
    enabled: status === 'authenticated',
  });
}

/**
 * POST/PATCH answer with the whole cart: it replaces the cached one (header count and /cart).
 * A GET /cart still in flight is cancelled first, so its older answer cannot overwrite the new cart.
 */
function useCartMutation<TVariables>(request: (variables: TVariables) => Promise<CartMutationResponse>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: async ({ userId, currency, items, total }) => {
      await queryClient.cancelQueries({ queryKey: cartKeys.all });
      queryClient.setQueryData<Cart>(cartKeys.all, { userId, currency, items, total });
    },
  });
}

/** POST /cart/items (adds to the quantity); `inventoryChecked: false` = stock is checked at the order. */
export function useAddToCart() {
  return useCartMutation((body: AddCartItemRequest) =>
    apiRequest<CartMutationResponse>(paths.cart.items, { method: 'POST', body }),
  );
}

/** PATCH /cart/items/{productId} with the new quantity (1–999). */
export function useChangeCartItem() {
  return useCartMutation(({ productId, quantity }: AddCartItemRequest) =>
    apiRequest<CartMutationResponse>(paths.cart.item(productId), { method: 'PATCH', body: { quantity } }),
  );
}

/** DELETE /cart/items/{productId} (204, idempotent): the cart is read again. */
export function useRemoveCartItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (productId: string) => apiRequest<void>(paths.cart.item(productId), { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: cartKeys.all }),
  });
}
