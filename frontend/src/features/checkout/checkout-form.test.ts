import { describe, expect, it } from 'vitest';
import type { Address } from '@/api/types';
import { checkoutSchema, NEW_ADDRESS, toOrderRequest, type CheckoutInput } from '@/features/checkout/checkout-form';

const SAVED: Address = { id: 'ad000000-0000-4000-8000-000000000001', street: 'ul. Testowa 1', city: 'Warszawa', postalCode: '00-001', countryCode: 'PL' };

const base: CheckoutInput = {
  addressChoice: SAVED.id,
  firstName: ' Jan ',
  lastName: 'Kowalski',
  street: '',
  city: '',
  postalCode: '',
  countryCode: 'PL',
  saveAddress: false,
  shippingMethod: 'COURIER',
  cardNumber: '4111 1111 1111 1111',
};

describe('checkoutSchema', () => {
  it('removes spaces from the card number and accepts 12–19 digits', () => {
    expect(checkoutSchema.parse(base).cardNumber).toBe('4111111111111111');
    expect(checkoutSchema.safeParse({ ...base, cardNumber: '1234 5678 901' }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...base, cardNumber: '1'.repeat(20) }).success).toBe(false);
    expect(checkoutSchema.safeParse({ ...base, cardNumber: '4111-1111-1111' }).success).toBe(false);
  });

  it('a new address must be complete; a saved one ignores the address fields', () => {
    const result = checkoutSchema.safeParse({ ...base, addressChoice: NEW_ADDRESS, countryCode: 'POL' });
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['street', 'city', 'postalCode', 'countryCode']));
  });

  it('requires a shipping method and names', () => {
    const result = checkoutSchema.safeParse({ ...base, shippingMethod: '', firstName: ' ' });
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(expect.arrayContaining(['shippingMethod', 'firstName']));
  });
});

describe('toOrderRequest', () => {
  it('uses the saved address and the names from the form', () => {
    const { order, addressToSave } = toOrderRequest(checkoutSchema.parse(base), [SAVED])!;
    expect(order).toEqual({
      shippingMethod: 'COURIER',
      shippingAddress: { firstName: 'Jan', lastName: 'Kowalski', street: 'ul. Testowa 1', postalCode: '00-001', city: 'Warszawa', countryCode: 'PL' },
      payment: { cardNumber: '4111111111111111' },
    });
    expect(addressToSave).toBeNull();
  });

  it('a new address is trimmed, the country upper-cased, and saved only when asked', () => {
    const values = checkoutSchema.parse({ ...base, addressChoice: NEW_ADDRESS, street: ' Długa 5 ', city: 'Kraków', postalCode: '30-001', countryCode: 'de', saveAddress: true });
    const { order, addressToSave } = toOrderRequest(values, [SAVED])!;
    expect(order.shippingAddress).toEqual({ firstName: 'Jan', lastName: 'Kowalski', street: 'Długa 5', postalCode: '30-001', city: 'Kraków', countryCode: 'DE' });
    expect(addressToSave).toEqual({ street: 'Długa 5', city: 'Kraków', postalCode: '30-001', countryCode: 'DE' });
    expect(toOrderRequest({ ...values, saveAddress: false }, [])?.addressToSave).toBeNull();
  });

  it('a saved address that is not on the list → null (the page asks to choose the address again)', () => {
    expect(toOrderRequest(checkoutSchema.parse(base), [])).toBeNull();
  });
});
