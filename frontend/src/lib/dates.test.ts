// Vitest runs with TZ=Europe/Warsaw (vite.config.ts): 08:30Z in November is 09:30 local time.
import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from '@/lib/dates';

describe('dates', () => {
  it('formats an ISO date in pl-PL', () => {
    expect(formatDate('2026-11-09T08:30:00.000Z')).toBe('9 lis 2026');
    expect(formatDateTime('2026-11-09T08:30:00.000Z')).toBe('9 lis 2026, 09:30');
  });

  it.each(['', 'abc', '2026-13-45T99:00:00Z'])('bad text %j → "—" without an exception', (value) => {
    expect(formatDate(value)).toBe('—');
    expect(formatDateTime(value)).toBe('—');
  });

  it('a value that is not text at all (bad API response) → "—"', () => {
    expect(formatDateTime(undefined as unknown as string)).toBe('—');
    expect(formatDate({} as unknown as string)).toBe('—');
  });

  it.each([null, 0, '12', '2026', '2026-11-09', '09.11.2026 08:30', 'Mon, 09 Nov 2026 08:30:00 GMT'])(
    'not an ISO 8601 date-time %j → "—" (new Date() would accept it)',
    (value) => {
      expect(formatDate(value as unknown as string)).toBe('—');
      expect(formatDateTime(value as unknown as string)).toBe('—');
    },
  );
});
