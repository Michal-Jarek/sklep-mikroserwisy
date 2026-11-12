// Amounts come from the API as text with two decimals, e.g. "19.99" (D3, decision 9). The only sum in
// the frontend ("Do zapłaty" = cart total + shipping) is computed in grosze as integers.

const AMOUNT = /^-?\d{1,12}(\.\d{1,2})?$/;

/** "19.99" → 1999. Throws for text that is not an amount. */
export function toGrosze(amount: string): number {
  if (!AMOUNT.test(amount)) throw new Error(`Invalid amount: ${amount}`);
  const negative = amount.startsWith('-');
  const [zloty, fraction = ''] = amount.replace('-', '').split('.');
  const grosze = Number(zloty) * 100 + Number(fraction.padEnd(2, '0'));
  return negative ? -grosze : grosze;
}

/** 5497 → "54.97". */
export function fromGrosze(grosze: number): string {
  const sign = grosze < 0 ? '-' : '';
  const abs = Math.abs(grosze);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Sum of amounts without floating point errors: addAmounts("0.10", "0.20") → "0.30"; null when one is not an amount (Z17 c). */
export function addAmounts(...amounts: string[]): string | null {
  if (!amounts.every((amount) => typeof amount === 'string' && AMOUNT.test(amount))) return null;
  return fromGrosze(amounts.reduce((sum, amount) => sum + toGrosze(amount), 0));
}

/** "54.97", "PLN" → "54,97 zł" (pl-PL). Text that is not an amount or a bad currency code → "—" (Z17 c). */
export function formatMoney(amount: string, currency: string = 'PLN'): string {
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) return '—';
  try {
    return new Intl.NumberFormat('pl-PL', { style: 'currency', currency }).format(toGrosze(amount) / 100);
  } catch {
    // RangeError: the currency is not a valid ISO 4217 code.
    return '—';
  }
}

/** Price typed by a user ("19,9", " 19.99 ") → "19.90"; null when it is not a non-negative amount. */
export function parseAmountInput(value: string): string | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(normalized)) return null;
  return fromGrosze(toGrosze(normalized));
}
