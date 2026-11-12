// Checkout form: address (saved or new), names, shipping method and the test card (wytyczne 3.6).
// The card number lives only in the form state: it is sent once in POST /orders and never stored.
import { z } from 'zod';
import type { Address, AddressRequest, CreateOrderRequest, ShippingMethodCode } from '@/api/types';
import { addressSchema, personNameField } from '@/features/account/fields';

/** Value of the address choice for a new address typed in the form. */
export const NEW_ADDRESS = 'new';

export const checkoutSchema = z
  .object({
    addressChoice: z.string().min(1, 'Wybierz adres dostawy.'),
    firstName: personNameField,
    lastName: personNameField,
    street: z.string(),
    city: z.string(),
    postalCode: z.string(),
    countryCode: z.string(),
    saveAddress: z.boolean(),
    shippingMethod: z.string().min(1, 'Wybierz sposób dostawy.'),
    cardNumber: z
      .string()
      .transform((value) => value.replace(/\s/g, ''))
      .pipe(z.string().regex(/^\d{12,19}$/, 'Numer karty musi mieć od 12 do 19 cyfr.')),
  })
  .superRefine((values, ctx) => {
    if (values.addressChoice !== NEW_ADDRESS) return;
    const result = addressSchema.safeParse(values);
    if (result.success) return;
    for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  });

export type CheckoutInput = z.input<typeof checkoutSchema>;
export type CheckoutValues = z.output<typeof checkoutSchema>;

/**
 * Body of POST /orders and the new address to save in the profile (when "Zapisz w profilu" is checked).
 * null: the chosen saved address is not on the list (e.g. the list could not be reloaded after saving).
 */
export function toOrderRequest(
  values: CheckoutValues,
  savedAddresses: readonly Address[],
): { order: CreateOrderRequest; addressToSave: AddressRequest | null } | null {
  const isNew = values.addressChoice === NEW_ADDRESS;
  const address: AddressRequest | undefined = isNew ? addressSchema.parse(values) : savedAddresses.find((a) => a.id === values.addressChoice);
  if (!address) return null;
  return {
    order: {
      shippingMethod: values.shippingMethod as ShippingMethodCode,
      shippingAddress: {
        firstName: values.firstName,
        lastName: values.lastName,
        street: address.street,
        postalCode: address.postalCode,
        city: address.city,
        countryCode: address.countryCode,
      },
      payment: { cardNumber: values.cardNumber },
    },
    addressToSave: isNew && values.saveAddress ? { street: address.street, city: address.city, postalCode: address.postalCode, countryCode: address.countryCode } : null,
  };
}
