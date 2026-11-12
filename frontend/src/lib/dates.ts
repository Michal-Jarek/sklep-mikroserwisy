// Dates from the API (ISO 8601) in the pl-PL format, in the time zone of the browser. Anything that is
// not an ISO 8601 date-time shows "—" instead of throwing (Z17 c): one bad field must not take down the page.
// The format is checked first: new Date() also accepts null (1970) and short numbers ("12" → 2001).

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T/;

const dateFormat = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium' });
const dateTimeFormat = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });

function format(formatter: Intl.DateTimeFormat, value: string): string {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : formatter.format(date);
}

/** "2026-11-09T08:30:00.000Z" → "9 lis 2026". */
export function formatDate(value: string): string {
  return format(dateFormat, value);
}

/** "2026-11-09T08:30:00.000Z" → "9 lis 2026, 09:30". */
export function formatDateTime(value: string): string {
  return format(dateTimeFormat, value);
}

