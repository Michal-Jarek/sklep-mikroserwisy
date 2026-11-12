// Product form of the admin panel: rules of POST/PUT /products (wytyczne 3.6, 3.7) checked before sending.
import { z } from 'zod';
import type { ProductDetail, ProductRequest } from '@/api/types';
import { parseAmountInput, toGrosze } from '@/lib/money';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const productFormSchema = z.object({
  name: z.string().trim().min(1, 'Podaj nazwę.').max(200, 'Najwyżej 200 znaków.'),
  description: z.string().trim().max(5000, 'Najwyżej 5000 znaków.'),
  // Price stays text all the way (D3): comma or dot, at most 8 digits and 2 decimals.
  price: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const amount = parseAmountInput(value);
      if (amount === null) {
        ctx.addIssue({ code: 'custom', message: 'Podaj cenę, np. 19,99.' });
        return z.NEVER;
      }
      if (toGrosze(amount) < 1) {
        ctx.addIssue({ code: 'custom', message: 'Cena musi wynosić co najmniej 0,01 zł.' });
        return z.NEVER;
      }
      return amount;
    }),
  categoryId: z.string().regex(UUID, 'Wybierz kategorię.'),
  imageUrl: z
    .string()
    .trim()
    .max(2000, 'Najwyżej 2000 znaków.')
    .refine((value) => value === '' || /^https:\/\/[^\s/]+\S*$/.test(value), 'Podaj adres zaczynający się od https:// albo zostaw puste.')
    .transform((value) => (value === '' ? null : value)),
});

export type ProductFormInput = z.input<typeof productFormSchema>;
export type ProductFormOutput = z.output<typeof productFormSchema>;

export const EMPTY_PRODUCT_FORM: ProductFormInput = { name: '', description: '', price: '', categoryId: '', imageUrl: '' };

/** Form values of an existing product; the price is shown with a comma like Polish users type it. */
export function productFormValues(product: ProductDetail): ProductFormInput {
  return {
    name: product.name,
    description: product.description,
    price: product.price.replace('.', ','),
    categoryId: product.category.id,
    imageUrl: product.imageUrl ?? '',
  };
}

export function toProductRequest(values: ProductFormOutput): ProductRequest {
  return { ...values, currency: 'PLN' };
}

export const stockFormSchema = z.object({
  quantity: z
    .string()
    .trim()
    .regex(/^\d+$/, 'Podaj liczbę całkowitą od 0 do 1 000 000.')
    .transform(Number)
    .refine((value) => value <= 1_000_000, 'Podaj liczbę całkowitą od 0 do 1 000 000.'),
});
