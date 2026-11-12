// Texts of the product rating (wytyczne 3.6): null = Review unavailable, count 0 = no reviews.
import type { ProductRating } from '@/api/types';

/** Polish plural: 1 opinia, 2–4 opinie (but 12–14 opinii), otherwise opinii. */
export function reviewCountLabel(count: number): string {
  const lastDigit = count % 10;
  const lastTwo = count % 100;
  if (count === 1) return '1 opinia';
  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${count} opinie`;
  return `${count} opinii`;
}

export function ratingLabel(rating: ProductRating | null): string {
  if (rating === null) return 'Ocena chwilowo niedostępna';
  if (rating.count === 0 || rating.average === null) return 'Brak opinii';
  // A number formatted here, not in src/lib (G3 exception): a bad value from the API shows "—" (Z17 c).
  const average =
    typeof rating.average === 'number' && Number.isFinite(rating.average)
      ? rating.average.toLocaleString('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : '—';
  return `${average} / 5 (${reviewCountLabel(rating.count)})`;
}

/** Stars of one review: an integer 1–5, otherwise null (a bad value from the API shows "—", Z17 c). */
export function reviewStars(rating: unknown): number | null {
  return typeof rating === 'number' && Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
}
