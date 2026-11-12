import { describe, expect, it } from 'vitest';
import { productFormSchema, productFormValues, stockFormSchema, toProductRequest } from '@/features/admin/product-form';
import type { ProductDetail } from '@/api/types';

const CATEGORY = 'c0000000-0000-4000-8000-000000000001';
const valid = { name: 'Kubek', description: '', price: '19,99', categoryId: CATEGORY, imageUrl: '' };

describe('product form schema', () => {
  it('turns a price with a comma into "19.99" and an empty image address into null', () => {
    const values = productFormSchema.parse(valid);
    expect(toProductRequest(values)).toEqual({ name: 'Kubek', description: '', price: '19.99', currency: 'PLN', categoryId: CATEGORY, imageUrl: null });
  });

  it.each([
    ['19.99', '19.99'],
    ['19,9', '19.90'],
    [' 7 ', '7.00'],
    ['99999999,99', '99999999.99'],
  ])('accepts the price %j as %j', (price, expected) => {
    expect(productFormSchema.parse({ ...valid, price }).price).toBe(expected);
  });

  it.each(['', 'abc', '19.999', '1,2,3', '-1', '123456789', '0', '0,00', '1e3'])('rejects the price %j', (price) => {
    expect(productFormSchema.safeParse({ ...valid, price }).success).toBe(false);
  });

  it('checks name 1–200, description up to 5000, category and https image address up to 2000', () => {
    const fails = (change: Partial<typeof valid>) => !productFormSchema.safeParse({ ...valid, ...change }).success;
    expect(fails({ name: '  ' })).toBe(true);
    expect(fails({ name: 'a'.repeat(201) })).toBe(true);
    expect(fails({ name: 'a'.repeat(200) })).toBe(false);
    expect(fails({ description: 'a'.repeat(5001) })).toBe(true);
    expect(fails({ description: 'a'.repeat(5000) })).toBe(false);
    expect(fails({ categoryId: '' })).toBe(true);
    expect(fails({ imageUrl: 'http://img.example/a.png' })).toBe(true);
    expect(fails({ imageUrl: 'https://' })).toBe(true);
    expect(fails({ imageUrl: `https://img.example/${'a'.repeat(1981)}` })).toBe(true);
    expect(productFormSchema.parse({ ...valid, imageUrl: 'https://img.example/a.png' }).imageUrl).toBe('https://img.example/a.png');
  });

  it('fills the form from a product with the price written with a comma', () => {
    const product = { name: 'Kubek', description: 'Opis', price: '19.99', category: { id: CATEGORY, name: 'Kuchnia' }, imageUrl: null } as ProductDetail;
    expect(productFormValues(product)).toEqual({ name: 'Kubek', description: 'Opis', price: '19,99', categoryId: CATEGORY, imageUrl: '' });
  });
});

describe('stock form schema', () => {
  it.each([
    ['0', 0],
    ['1000000', 1_000_000],
    [' 15 ', 15],
  ])('accepts %j', (quantity, expected) => {
    expect(stockFormSchema.parse({ quantity }).quantity).toBe(expected);
  });

  it.each(['', '-1', '1.5', '1000001', 'abc'])('rejects %j', (quantity) => {
    expect(stockFormSchema.safeParse({ quantity }).success).toBe(false);
  });
});
