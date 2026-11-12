// Polish labels of statuses and shipping methods (wytyczne 3.6).
import type { OrderStatus, ShipmentStatus } from '@/api/types';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  NEW: 'Nowe',
  PAID: 'Opłacone',
  PAYMENT_FAILED: 'Płatność nieudana',
  SHIPPED: 'Wysłane',
  DELIVERED: 'Dostarczone',
  CANCELLED: 'Anulowane',
};

export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  PREPARING: 'W przygotowaniu',
  SHIPPED: 'Wysłana',
  IN_TRANSIT: 'W drodze',
  DELIVERED: 'Dostarczona',
  CANCELLED: 'Anulowana',
};

export const SHIPPING_METHOD_LABELS: Record<string, string> = {
  COURIER: 'Kurier',
  PARCEL_LOCKER: 'Paczkomat',
  PICKUP: 'Odbiór osobisty',
};

/** Label of a shipping method; an unknown code shows `name` from the API (or the code). */
export function shippingMethodLabel(code: string, name?: string): string {
  return SHIPPING_METHOD_LABELS[code] ?? name ?? code;
}
