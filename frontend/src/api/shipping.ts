// Shipping methods (Shipping Service) for checkout.
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/api/client';
import { paths } from '@/api/paths';
import type { ShippingMethod } from '@/api/types';

export const shippingKeys = {
  methods: ['shipping', 'methods'] as const,
};

/** GET /shipping/methods. Methods rarely change, so they stay fresh for 5 minutes. */
export function useShippingMethods() {
  return useQuery({
    queryKey: shippingKeys.methods,
    queryFn: ({ signal }) => apiRequest<ShippingMethod[]>(paths.shipping.methods, { signal }),
    staleTime: 5 * 60 * 1000,
  });
}
