import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { cartKeys, useChangeCartItem } from '@/api/cart';
import { apiRequest } from '@/api/client';
import type { Cart, CartMutationResponse } from '@/api/types';

vi.mock('@/api/client', () => ({ apiRequest: vi.fn() }));

const PRODUCT = 'a0000000-0000-4000-8000-000000000001';
const cartWith = (quantity: number): Cart => ({
  userId: 'c0000000-0000-4000-8000-000000000001',
  currency: 'PLN',
  items: [{ productId: PRODUCT, name: 'Kubek', unitPrice: '10.00', quantity, subtotal: `${quantity * 10}.00` }],
  total: `${quantity * 10}.00`,
});

describe('cart mutations', () => {
  it('an older GET /cart still in flight does not overwrite the cart returned by PATCH', async () => {
    const queryClient = new QueryClient();
    let answerOldGet: (cart: Cart) => void = () => {};
    // GET /cart started before the change (e.g. a refetch on window focus) and answers after it.
    void queryClient.fetchQuery({ queryKey: cartKeys.all, queryFn: () => new Promise<Cart>((resolve) => (answerOldGet = resolve)) }).catch(() => {});
    const updated: CartMutationResponse = { ...cartWith(3), inventoryChecked: true };
    vi.mocked(apiRequest).mockResolvedValueOnce(updated);
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useChangeCartItem(), { wrapper });

    await act(() => result.current.mutateAsync({ productId: PRODUCT, quantity: 3 }));
    await act(async () => answerOldGet(cartWith(1)));

    expect(queryClient.getQueryData<Cart>(cartKeys.all)?.items[0].quantity).toBe(3);
  });
});
