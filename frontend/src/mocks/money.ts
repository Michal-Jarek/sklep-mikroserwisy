// Amounts in the mocks are integers in grosze; the API gets them as text "19.99" (decision D3).

export function toMoney(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return `${whole}.${rest.toString().padStart(2, '0')}`;
}

/** "19.99", "19.9" or "19" -> grosze; anything else -> null. */
export function parseMoney(text: string, pattern: RegExp): number | null {
  if (!pattern.test(text)) {
    return null;
  }
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Exactly two decimals, as in requests and responses (D3). */
export const MONEY_PATTERN = /^[0-9]{1,8}\.[0-9]{2}$/;
/** Price filters of GET /products: one or two decimals or none. */
export const PRICE_FILTER_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;
