import { describe, expect, it } from 'vitest';
import { ApiError, ERROR_MESSAGES, NETWORK_ERROR, errorMessage, isTemporaryError } from '@/api/errors';

function apiError(status: number, code: string, retryAfter: number | null = null): ApiError {
  return new ApiError({ status, code, message: 'technical text', requestId: 'rid', retryAfter });
}

const SEND_FAILED = 'Nie udało się wysłać żądania.';
const UNAVAILABLE = 'Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.';
const UNEXPECTED = 'Wystąpił nieoczekiwany błąd.';

// docs/decisions.md D7 (common codes) and the domain code register, Gateway README "Kody błędów",
// wytyczne 3.6/3.7 (codes of services the frontend talks to).
const EXPECTED: [status: number, code: string, message: string][] = [
  [400, 'VALIDATION_ERROR', 'Sprawdź wprowadzone dane.'],
  [400, 'BAD_REQUEST', 'Sprawdź wprowadzone dane.'],
  [401, 'INVALID_CREDENTIALS', 'Nieprawidłowy e-mail lub hasło.'],
  [401, 'UNAUTHORIZED', 'Zaloguj się, aby kontynuować.'],
  [403, 'FORBIDDEN', 'Nie masz uprawnień do tej operacji.'],
  [404, 'NOT_FOUND', 'Nie znaleziono.'],
  [405, 'METHOD_NOT_ALLOWED', SEND_FAILED],
  [408, 'REQUEST_TIMEOUT', SEND_FAILED],
  [409, 'CONFLICT', 'Operacja koliduje z aktualnym stanem danych.'],
  [409, 'EMAIL_TAKEN', 'Konto z tym adresem e-mail już istnieje.'],
  [409, 'INSUFFICIENT_STOCK', 'Za mało sztuk w magazynie.'],
  [409, 'CART_EMPTY', 'Koszyk jest pusty.'],
  [409, 'ORDER_NOT_CANCELLABLE', 'Tego zamówienia nie można już anulować.'],
  [409, 'INVALID_STATUS_TRANSITION', 'Nie można zmienić statusu przesyłki w ten sposób.'],
  [413, 'PAYLOAD_TOO_LARGE', SEND_FAILED],
  [415, 'UNSUPPORTED_MEDIA_TYPE', SEND_FAILED],
  [429, 'TOO_MANY_REQUESTS', 'Zbyt wiele prób. Spróbuj ponownie za chwilę.'],
  [429, 'TOO_MANY_ATTEMPTS', 'Konto jest czasowo zablokowane. Spróbuj ponownie później.'],
  [431, 'REQUEST_HEADER_FIELDS_TOO_LARGE', SEND_FAILED],
  [500, 'INTERNAL_ERROR', UNEXPECTED],
  [500, 'INTERNAL_SERVER_ERROR', UNEXPECTED],
  [502, 'BAD_GATEWAY', UNAVAILABLE],
  [503, 'SERVICE_UNAVAILABLE', UNAVAILABLE],
  [504, 'GATEWAY_TIMEOUT', UNAVAILABLE],
];

describe('error messages', () => {
  it.each(EXPECTED)('%i %s has the Polish message', (status, code, message) => {
    expect(ERROR_MESSAGES[code]).toBe(message);
    expect(errorMessage(apiError(status, code))).toBe(message);
  });

  it('every code of the register, D7, the Gateway table and 3.6 has a message', () => {
    const codes = ['INVALID_CREDENTIALS', 'EMAIL_TAKEN', 'TOO_MANY_ATTEMPTS', 'INSUFFICIENT_STOCK', 'CART_EMPTY', 'ORDER_NOT_CANCELLABLE', 'INVALID_STATUS_TRANSITION', 'VALIDATION_ERROR', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'METHOD_NOT_ALLOWED', 'CONFLICT', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'TOO_MANY_REQUESTS', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'REQUEST_TIMEOUT', 'REQUEST_HEADER_FIELDS_TOO_LARGE', 'BAD_GATEWAY', 'GATEWAY_TIMEOUT', 'BAD_REQUEST', 'INTERNAL_SERVER_ERROR'];
    expect(codes.filter((code) => !ERROR_MESSAGES[code])).toEqual([]);
  });

  it('TOO_MANY_ATTEMPTS shows the lock time in minutes from Retry-After', () => {
    expect(errorMessage(apiError(429, 'TOO_MANY_ATTEMPTS', 900))).toBe('Konto jest czasowo zablokowane. Spróbuj ponownie za 15 min.');
    expect(errorMessage(apiError(429, 'TOO_MANY_ATTEMPTS', 61))).toBe('Konto jest czasowo zablokowane. Spróbuj ponownie za 2 min.');
  });

  it('TOO_MANY_REQUESTS shows the wait time in seconds from Retry-After', () => {
    expect(errorMessage(apiError(429, 'TOO_MANY_REQUESTS', 37))).toBe('Zbyt wiele prób. Spróbuj ponownie za 37 s.');
  });

  it('a network error says the service is unavailable', () => {
    expect(errorMessage(apiError(0, NETWORK_ERROR))).toBe(UNAVAILABLE);
  });

  it('an unknown code falls back to the status', () => {
    expect(errorMessage(apiError(409, 'SOMETHING_NEW'))).toBe('Operacja koliduje z aktualnym stanem danych.');
    expect(errorMessage(apiError(404, 'HTTP_404'))).toBe('Nie znaleziono.');
    expect(errorMessage(apiError(503, 'HTTP_503'))).toBe(UNAVAILABLE);
    expect(errorMessage(apiError(500, 'HTTP_500'))).toBe(UNEXPECTED);
    expect(errorMessage(apiError(418, 'TEAPOT'))).toBe(SEND_FAILED);
  });

  it('uses messages of the context: review 403 and 409, cart 409', () => {
    expect(errorMessage(apiError(403, 'FORBIDDEN'), 'review')).toBe('Opinię może dodać tylko osoba, która kupiła ten produkt.');
    expect(errorMessage(apiError(409, 'CONFLICT'), 'review')).toBe('Ten produkt już oceniłeś.');
    expect(errorMessage(apiError(409, 'CONFLICT'), 'cart')).toBe('Za mało sztuk w magazynie.');
    expect(errorMessage(apiError(503, 'SERVICE_UNAVAILABLE'), 'review')).toBe(UNAVAILABLE);
  });

  it('a value that is not an ApiError gets the generic message', () => {
    expect(errorMessage(new TypeError('x is undefined'))).toBe(UNEXPECTED);
  });

  it('only no connection and 502/503/504 are temporary', () => {
    expect([0, 502, 503, 504].every((status) => isTemporaryError(apiError(status, 'X')))).toBe(true);
    expect([400, 429, 500].some((status) => isTemporaryError(apiError(status, 'X')))).toBe(false);
  });
});
