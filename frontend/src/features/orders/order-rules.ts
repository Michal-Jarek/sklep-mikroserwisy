// Order texts, the cancel rule and the shipment polling rule shared by the history, the details and checkout.
import { ORDER_REFRESH_MS, orderRefreshInterval } from '@/api/orders';
import type { OrderStatus, Shipment } from '@/api/types';

/** Last 8 characters of the order UUID, shown as the order number. */
export function shortOrderId(orderId: string): string {
  return orderId.slice(-8).toUpperCase();
}

/**
 * "Anuluj zamówienie" only for NEW/PAID without a shipment or with a PREPARING one (decision 15).
 * `shipment` undefined = no shipment yet (Shipping creates it after the order.created event);
 * 'unavailable' = Shipping did not answer: the order status decides, Order checks the shipment itself
 * (409 ORDER_NOT_CANCELLABLE is handled by the page).
 */
export function canCancelOrder(status: OrderStatus, shipment: Shipment | undefined | 'unavailable'): boolean {
  if (status !== 'NEW' && status !== 'PAID') return false;
  return shipment === undefined || shipment === 'unavailable' || shipment.status === 'PREPARING';
}

/**
 * Polling interval of the shipment: like the order (decision 15) and, after cancelling, until the shipment
 * is no longer PREPARING (Shipping cancels it only after the order.cancelled event).
 */
export function shipmentRefreshInterval(orderStatus: OrderStatus | undefined, shipment: Shipment | undefined): number | false {
  if (orderStatus === 'CANCELLED' && shipment?.status === 'PREPARING') return ORDER_REFRESH_MS;
  return orderRefreshInterval(orderStatus);
}
