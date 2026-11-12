// Orders of the logged-in customer (Order Service): checkout, history, details and cancelling.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cartKeys } from '@/api/cart';
import { apiRequest } from '@/api/client';
import { ApiError } from '@/api/errors';
import { paths } from '@/api/paths';
import { shipmentKeys } from '@/api/shipments';
import type { CreateOrderRequest, OrderDetail, OrderStatus, OrderSummary, Page } from '@/api/types';

export const ORDERS_PAGE_SIZE = 10;
/** Order details are polled every 10 s while the tab is visible and the status is not final (decision 15). */
export const ORDER_REFRESH_MS = 10_000;

const FINAL_STATUSES: ReadonlySet<OrderStatus> = new Set(['PAYMENT_FAILED', 'DELIVERED', 'CANCELLED']);

/** Polling interval of an order and its shipment: none for a final status (or before the order is loaded). */
export function orderRefreshInterval(status: OrderStatus | undefined): number | false {
  return status === undefined || FINAL_STATUSES.has(status) ? false : ORDER_REFRESH_MS;
}

export const orderKeys = {
  all: ['orders'] as const,
  lists: () => [...orderKeys.all, 'list'] as const,
  list: (page: number) => [...orderKeys.lists(), page] as const,
  detail: (orderId: string) => [...orderKeys.all, 'detail', orderId] as const,
};

/** GET /orders: own orders, newest first. */
export function useOrders(page: number) {
  return useQuery({
    queryKey: orderKeys.list(page),
    queryFn: ({ signal }) =>
      apiRequest<Page<OrderSummary>>(paths.orders.list, { query: { page, size: ORDERS_PAGE_SIZE }, signal }),
    placeholderData: keepPreviousData,
  });
}

/** GET /orders/{orderId}, polled while the status may still change (only in a visible tab). */
export function useOrder(orderId: string) {
  return useQuery({
    queryKey: orderKeys.detail(orderId),
    queryFn: ({ signal }) => apiRequest<OrderDetail>(paths.orders.detail(orderId), { signal }),
    refetchInterval: (query) => orderRefreshInterval(query.state.data?.status),
    refetchIntervalInBackground: false,
  });
}

/** POST /orders: Order takes the items from the cart; 201 with status PAID or PAYMENT_FAILED. */
export function useCreateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateOrderRequest) => apiRequest<OrderDetail>(paths.orders.list, { method: 'POST', body }),
    onSuccess: (order) => {
      queryClient.setQueryData(orderKeys.detail(order.id), order);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: cartKeys.all }),
        queryClient.invalidateQueries({ queryKey: orderKeys.lists() }),
      ]);
    },
  });
}

/** POST /orders/{orderId}/cancel; 409 ORDER_NOT_CANCELLABLE refreshes the order and the shipment. */
export function useCancelOrder(orderId: string) {
  const queryClient = useQueryClient();
  const refreshShipments = () => queryClient.invalidateQueries({ queryKey: shipmentKeys.lists() });
  return useMutation({
    mutationFn: () => apiRequest<OrderDetail>(paths.orders.cancel(orderId), { method: 'POST' }),
    onSuccess: (order) => {
      queryClient.setQueryData(orderKeys.detail(orderId), order);
      return Promise.all([refreshShipments(), queryClient.invalidateQueries({ queryKey: orderKeys.lists() })]);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        return Promise.all([queryClient.invalidateQueries({ queryKey: orderKeys.detail(orderId) }), refreshShipments()]);
      }
    },
  });
}
