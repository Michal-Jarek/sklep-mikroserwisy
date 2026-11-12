import { formatMoney } from '@/lib/money';

/** Amount from the API ("19.99") in the pl-PL currency format. */
export function Money({ amount, currency = 'PLN', className }: { amount: string; currency?: string; className?: string }) {
  return <span className={className}>{formatMoney(amount, currency)}</span>;
}
