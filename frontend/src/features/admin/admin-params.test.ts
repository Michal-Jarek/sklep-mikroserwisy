import { describe, expect, it } from 'vitest';
import { nextShipmentStatus, readAdminProductsQuery, readAdminShipmentsQuery } from '@/features/admin/admin-params';

describe('admin list filters from the address', () => {
  it('products: q and page, invalid values left out', () => {
    expect(readAdminProductsQuery(new URLSearchParams('q=%20kubek%20&page=3'))).toEqual({ q: 'kubek', page: 3, size: 20 });
    expect(readAdminProductsQuery(new URLSearchParams('q=&page=-2'))).toEqual({ q: undefined, page: 1, size: 20 });
    expect(readAdminProductsQuery(new URLSearchParams(`q=${'a'.repeat(250)}`)).q).toHaveLength(200);
  });

  it('shipments: only a known status', () => {
    expect(readAdminShipmentsQuery(new URLSearchParams('status=IN_TRANSIT&page=2'))).toEqual({ status: 'IN_TRANSIT', page: 2, size: 20 });
    expect(readAdminShipmentsQuery(new URLSearchParams('status=LOST&page=x'))).toEqual({ status: undefined, page: 1, size: 20 });
  });
});

describe('next shipment status', () => {
  it('moves one step forward and stops at DELIVERED and CANCELLED', () => {
    expect(nextShipmentStatus('PREPARING')).toBe('SHIPPED');
    expect(nextShipmentStatus('SHIPPED')).toBe('IN_TRANSIT');
    expect(nextShipmentStatus('IN_TRANSIT')).toBe('DELIVERED');
    expect(nextShipmentStatus('DELIVERED')).toBeNull();
    expect(nextShipmentStatus('CANCELLED')).toBeNull();
  });
});
