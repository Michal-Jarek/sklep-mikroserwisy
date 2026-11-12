import { describe, expect, it } from 'vitest';
import { orderRefreshInterval } from '@/api/orders';
import type { OrderStatus, Shipment, ShipmentStatus } from '@/api/types';
import { canCancelOrder, shipmentRefreshInterval, shortOrderId } from '@/features/orders/order-rules';

function shipment(status: ShipmentStatus): Shipment {
  return {
    id: 'e0000000-0000-4000-8000-000000000003',
    orderId: 'd0000000-0000-4000-8000-000000000003',
    userId: 'b0000000-0000-4000-8000-000000000001',
    status,
    method: 'COURIER',
    trackingNumber: null,
    history: [{ status, at: '2026-11-09T08:30:00.000Z' }],
    createdAt: '2026-11-09T08:30:00.000Z',
    updatedAt: '2026-11-09T08:30:00.000Z',
  };
}

describe('canCancelOrder', () => {
  it.each<[OrderStatus, ShipmentStatus | null, boolean]>([
    ['NEW', null, true],
    ['PAID', null, true],
    ['PAID', 'PREPARING', true],
    ['PAID', 'SHIPPED', false],
    ['PAID', 'IN_TRANSIT', false],
    ['SHIPPED', 'SHIPPED', false],
    ['DELIVERED', 'DELIVERED', false],
    ['CANCELLED', 'CANCELLED', false],
    ['CANCELLED', null, false],
    ['PAYMENT_FAILED', null, false],
  ])('%s with shipment %s → %s', (status, shipmentStatus, expected) => {
    expect(canCancelOrder(status, shipmentStatus ? shipment(shipmentStatus) : undefined)).toBe(expected);
  });

  it.each<[OrderStatus, boolean]>([
    ['NEW', true],
    ['PAID', true],
    ['SHIPPED', false],
    ['CANCELLED', false],
    ['PAYMENT_FAILED', false],
  ])('Shipping unavailable: %s → %s (the order status decides)', (status, expected) => {
    expect(canCancelOrder(status, 'unavailable')).toBe(expected);
  });
});

describe('orderRefreshInterval', () => {
  it('polls every 10 s while the status can change', () => {
    for (const status of ['NEW', 'PAID', 'SHIPPED'] as const) expect(orderRefreshInterval(status)).toBe(10_000);
  });

  it('stops for final statuses and before the order is loaded', () => {
    for (const status of ['PAYMENT_FAILED', 'DELIVERED', 'CANCELLED'] as const) expect(orderRefreshInterval(status)).toBe(false);
    expect(orderRefreshInterval(undefined)).toBe(false);
  });
});

describe('shipmentRefreshInterval', () => {
  it('follows the order while its status can change', () => {
    expect(shipmentRefreshInterval('PAID', shipment('PREPARING'))).toBe(10_000);
    expect(shipmentRefreshInterval('PAID', undefined)).toBe(10_000);
    expect(shipmentRefreshInterval('DELIVERED', shipment('DELIVERED'))).toBe(false);
    expect(shipmentRefreshInterval(undefined, undefined)).toBe(false);
  });

  it('a cancelled order keeps polling while its shipment is still PREPARING (order.cancelled is asynchronous)', () => {
    expect(shipmentRefreshInterval('CANCELLED', shipment('PREPARING'))).toBe(10_000);
    expect(shipmentRefreshInterval('CANCELLED', shipment('CANCELLED'))).toBe(false);
    expect(shipmentRefreshInterval('CANCELLED', undefined)).toBe(false);
  });
});

describe('order texts', () => {
  it('order number is the end of the UUID', () => {
    expect(shortOrderId('d0000000-0000-4000-8000-0000000abc03')).toBe('000ABC03');
  });
});
