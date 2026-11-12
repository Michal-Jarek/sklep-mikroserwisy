import { describe, expect, it } from 'vitest';
import { addAmounts, formatMoney, fromGrosze, parseAmountInput, toGrosze } from '@/lib/money';

describe('money', () => {
  it('formats amounts in pl-PL currency format', () => {
    expect(formatMoney('54.97', 'PLN')).toBe('54,97 zł');
    expect(formatMoney('0.5', 'PLN')).toBe('0,50 zł');
    expect(formatMoney('12345.60', 'PLN')).toBe('12 345,60 zł');
  });

  it('sums in grosze: "39.98" + "14.99" = "54.97"', () => {
    expect(addAmounts('39.98', '14.99')).toBe('54.97');
  });

  it('sums in grosze: "0.10" + "0.20" = "0.30"', () => {
    expect(addAmounts('0.10', '0.20')).toBe('0.30');
  });

  it('sum with text that is not an amount → null without an exception', () => {
    expect(addAmounts('39.98', 'abc')).toBeNull();
    expect(addAmounts(undefined as unknown as string, '1.00')).toBeNull();
  });

  it('converts between text and grosze', () => {
    expect(toGrosze('19.99')).toBe(1999);
    expect(toGrosze('7')).toBe(700);
    expect(toGrosze('0.5')).toBe(50);
    expect(fromGrosze(5)).toBe('0.05');
    expect(() => toGrosze('19,99')).toThrow();
  });

  it.each(['abc', '', '19,99', '1e3', '<b>1</b>'])('amount %j that is not an amount → "—"', (amount) => {
    expect(formatMoney(amount, 'PLN')).toBe('—');
  });

  it.each(['', 'ZŁOTY', 'P1N', '<script>'])('bad currency code %j → "—" without an exception', (currency) => {
    expect(formatMoney('19.99', currency)).toBe('—');
  });

  it('a value that is not text at all (bad API response) → "—"', () => {
    expect(formatMoney(null as unknown as string, 'PLN')).toBe('—');
  });

  it('parses a price typed with a comma or a dot', () => {
    expect(parseAmountInput('19,9')).toBe('19.90');
    expect(parseAmountInput(' 19.99 ')).toBe('19.99');
    expect(parseAmountInput('19.999')).toBeNull();
    expect(parseAmountInput('-1')).toBeNull();
    expect(parseAmountInput('')).toBeNull();
  });
});
