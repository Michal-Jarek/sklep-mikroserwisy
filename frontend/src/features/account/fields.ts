// Form fields validated like Auth and User do it (wytyczne 3.5, 3.7), so the customer sees
// the problem before sending.
import { z } from 'zod';

/** Length in bytes of UTF-8 (bcrypt in Auth uses at most 72 bytes; a Polish letter has 2). */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

const CONTROL_OR_LONE_SURROGATE = /[\p{Cc}\p{Cs}]/u;

export const emailField = z
  .string()
  .trim()
  .min(1, 'Podaj adres e-mail.')
  .max(254, 'Adres e-mail może mieć najwyżej 254 znaki.')
  .refine((value) => value.includes('@'), 'Podaj poprawny adres e-mail.');

export const loginPasswordField = z
  .string()
  .min(1, 'Podaj hasło.')
  .refine((value) => utf8Length(value) <= 72, 'Hasło może mieć najwyżej 72 bajty (polska litera liczy się za 2).');

export const newPasswordField = z
  .string()
  .refine((value) => utf8Length(value) >= 10, 'Hasło musi mieć co najmniej 10 znaków.')
  .refine((value) => utf8Length(value) <= 72, 'Hasło może mieć najwyżej 72 bajty (polska litera liczy się za 2).');

export const personNameField = z
  .string()
  .trim()
  .min(1, 'To pole jest wymagane.')
  .max(100, 'Najwyżej 100 znaków.')
  .refine((value) => !CONTROL_OR_LONE_SURROGATE.test(value), 'Usuń znaki specjalne (np. tabulator).');

export const addressSchema = z.object({
  street: z.string().trim().min(1, 'Podaj ulicę.').max(200, 'Najwyżej 200 znaków.'),
  city: z.string().trim().min(1, 'Podaj miasto.').max(100, 'Najwyżej 100 znaków.'),
  postalCode: z.string().trim().min(1, 'Podaj kod pocztowy.').max(20, 'Najwyżej 20 znaków.'),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Podaj kod kraju z 2 liter, np. PL.'),
});
