// Shipments (Shipping Service): order details (T4) and the admin panel (T5).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/api/client';
import { ApiError } from '@/api/errors';
import { paths } from '@/api/paths';
import type { Page, Shipment, ShipmentListQuery, ShipmentStatusUpdateRequest } from '@/api/types';

export const shipmentKeys = {
  all: ['shipments'] as const,
  lists: () => [...shipmentKeys.all, 'list'] as const,
  list: (params: ShipmentListQuery) => [...shipmentKeys.lists(), params] as const,
};

export interface ShipmentsQueryOptions {
  enabled?: boolean;
  /** Polling interval in ms (only while the tab is visible), or false. */
  refetchInterval?: number | false;
}

/** GET /shipments: a customer sees own shipments, ADMIN all. */
export function useShipments(params: ShipmentListQuery, options: ShipmentsQueryOptions = {}) {
  return useQuery({
    queryKey: shipmentKeys.list(params),
    queryFn: ({ signal }) => apiRequest<Page<Shipment>>(paths.shipments.list, { query: params, signal }),
    enabled: options.enabled,
    refetchInterval: options.refetchInterval,
  });
}

/**
 * PATCH /shipments/{shipmentId}/status (ADMIN): one step forward. The lists are refreshed after
 * success and after 409 INVALID_STATUS_TRANSITION (someone else changed the status in the meantime).
 */
export function useChangeShipmentStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ shipmentId, status }: { shipmentId: string } & ShipmentStatusUpdateRequest) =>
      apiRequest<Shipment>(paths.shipments.status(shipmentId), { method: 'PATCH', body: { status } }),
    onSettled: (_data, error) => {
      if (error === null || (error instanceof ApiError && error.status === 409)) {
        return queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
      }
    },
  });
}
