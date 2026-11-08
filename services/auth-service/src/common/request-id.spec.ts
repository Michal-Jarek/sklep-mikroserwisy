import { resolveRequestId } from './request-id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId', () => {
  it('keeps a valid id', () => {
    expect(resolveRequestId('k11-test.A_1')).toBe('k11-test.A_1');
  });

  it('keeps an id of exactly 64 characters', () => {
    const id = 'a'.repeat(64);
    expect(resolveRequestId(id)).toBe(id);
  });

  it('replaces an id longer than 64 characters with a UUID', () => {
    expect(resolveRequestId('a'.repeat(65))).toMatch(UUID_V4);
  });

  it('replaces an id with forbidden characters with a UUID', () => {
    expect(resolveRequestId('zly id!')).toMatch(UUID_V4);
    expect(resolveRequestId('a\nb')).toMatch(UUID_V4);
  });

  it('generates a UUID when the header is missing or empty', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_V4);
    expect(resolveRequestId('')).toMatch(UUID_V4);
  });

  it('uses the first value of a repeated header', () => {
    expect(resolveRequestId(['first', 'second'])).toBe('first');
  });
});
