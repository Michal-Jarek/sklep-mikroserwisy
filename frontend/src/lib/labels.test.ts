import { describe, expect, it } from 'vitest';
import { ORDER_STATUS_LABELS, SHIPMENT_STATUS_LABELS, shippingMethodLabel } from '@/lib/labels';

describe('labels', () => {
  it('has Polish labels for order and shipment statuses', () => {
    expect(ORDER_STATUS_LABELS.PAYMENT_FAILED).toBe('Płatność nieudana');
    expect(SHIPMENT_STATUS_LABELS.IN_TRANSIT).toBe('W drodze');
  });

  it('labels known shipping methods and falls back to the API name', () => {
    expect(shippingMethodLabel('PARCEL_LOCKER', 'Locker')).toBe('Paczkomat');
    expect(shippingMethodLabel('DRONE', 'Dron')).toBe('Dron');
    expect(shippingMethodLabel('DRONE')).toBe('DRONE');
  });
});
