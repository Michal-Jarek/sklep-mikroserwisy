import { describe, expect, it } from 'vitest';
import { ratingLabel, reviewCountLabel, reviewStars } from '@/features/product/rating';

describe('reviewCountLabel', () => {
  it.each([
    [1, '1 opinia'],
    [2, '2 opinie'],
    [4, '4 opinie'],
    [5, '5 opinii'],
    [12, '12 opinii'],
    [14, '14 opinii'],
    [22, '22 opinie'],
    [111, '111 opinii'],
  ])('%i → %s', (count, label) => {
    expect(reviewCountLabel(count)).toBe(label);
  });
});

describe('ratingLabel', () => {
  it('null rating means Review is unavailable', () => {
    expect(ratingLabel(null)).toBe('Ocena chwilowo niedostępna');
  });

  it('no reviews', () => {
    expect(ratingLabel({ average: null, count: 0 })).toBe('Brak opinii');
  });

  it('average with a Polish decimal comma', () => {
    expect(ratingLabel({ average: 4.1, count: 12 })).toBe('4,1 / 5 (12 opinii)');
    expect(ratingLabel({ average: 5, count: 1 })).toBe('5,0 / 5 (1 opinia)');
  });

  it('average that is not a finite number (bad API response) → "—" without an exception', () => {
    expect(ratingLabel({ average: '4.1' as unknown as number, count: 2 })).toBe('— / 5 (2 opinie)');
    expect(ratingLabel({ average: Number.NaN, count: 2 })).toBe('— / 5 (2 opinie)');
    expect(ratingLabel({ average: Number.POSITIVE_INFINITY, count: 2 })).toBe('— / 5 (2 opinie)');
  });
});

describe('reviewStars', () => {
  it('an integer 1–5 is the number of stars', () => {
    for (const rating of [1, 3, 5]) expect(reviewStars(rating)).toBe(rating);
  });

  it.each([0, 6, -1, 2.5, Number.NaN, '4', null, undefined])('%j (bad API response) → null', (rating) => {
    expect(reviewStars(rating)).toBeNull();
  });
});
