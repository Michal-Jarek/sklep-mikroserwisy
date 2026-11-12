import { describe, expect, it } from 'vitest';
import { addressSchema, emailField, loginPasswordField, newPasswordField, personNameField, utf8Length } from '@/features/account/fields';

describe('account fields', () => {
  it('counts the password length in UTF-8 bytes', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('ąę')).toBe(4);
  });

  it('new password: 10 to 72 bytes (Polish letters count twice)', () => {
    expect(newPasswordField.safeParse('a'.repeat(9)).success).toBe(false);
    expect(newPasswordField.safeParse('a'.repeat(10)).success).toBe(true);
    expect(newPasswordField.safeParse('a'.repeat(72)).success).toBe(true);
    expect(newPasswordField.safeParse('ą'.repeat(36)).success).toBe(true);
    expect(newPasswordField.safeParse('ą'.repeat(37)).success).toBe(false);
  });

  it('login password: 1 to 72 bytes', () => {
    expect(loginPasswordField.safeParse('').success).toBe(false);
    expect(loginPasswordField.safeParse('x').success).toBe(true);
    expect(loginPasswordField.safeParse('ą'.repeat(37)).success).toBe(false);
  });

  it('e-mail: trimmed, at most 254 characters, with @', () => {
    expect(emailField.parse('  anna@example.com ')).toBe('anna@example.com');
    expect(emailField.safeParse('anna.example.com').success).toBe(false);
    expect(emailField.safeParse(`${'a'.repeat(245)}@example.com`).success).toBe(false);
  });

  it('names: 1 to 100 characters without control characters', () => {
    expect(personNameField.parse(' Anna ')).toBe('Anna');
    expect(personNameField.safeParse('   ').success).toBe(false);
    expect(personNameField.safeParse('A'.repeat(101)).success).toBe(false);
    expect(personNameField.safeParse('An\tna').success).toBe(false);
    expect(personNameField.safeParse('An\uD800na').success).toBe(false);
  });

  it('address: country code of 2 letters (made upper case)', () => {
    expect(addressSchema.parse({ street: 'Prosta 1', city: 'Łódź', postalCode: '90-001', countryCode: 'pl' }).countryCode).toBe('PL');
    expect(addressSchema.safeParse({ street: 'Prosta 1', city: 'Łódź', postalCode: '90-001', countryCode: 'POL' }).success).toBe(false);
  });
});
