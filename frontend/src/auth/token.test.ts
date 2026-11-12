import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeToken } from '@/test/auth';

async function load() {
  vi.resetModules();
  return import('@/auth/token');
}

const MINUTE = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('token expiry in the clock of the browser (C19)', () => {
  it('a token is refreshed 30 s before the end of its lifetime (exp − iat), counted from when it was stored', async () => {
    const m = await load();
    vi.useFakeTimers({ toFake: ['Date'] });
    m.setAccessToken(fakeToken({ expiresInSeconds: 900 }));

    expect(m.tokenExpiresWithin(30_000)).toBe(false);
    vi.advanceTimersByTime(14 * MINUTE + 29_000);
    expect(m.tokenExpiresWithin(30_000)).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(m.tokenExpiresWithin(30_000)).toBe(true);
  });

  it.each([
    ['20 min ahead', 20],
    ['20 min behind', -20],
  ])('with the clock of the browser %s of Auth a fresh token is not expired and is refreshed on time', async (_name, minutes) => {
    const m = await load();
    // Auth issues the token now (iat, exp in its clock); the browser clock differs by `minutes`.
    const token = fakeToken({ expiresInSeconds: 900 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + minutes * MINUTE);
    m.setAccessToken(token);

    expect(m.tokenExpiresWithin(30_000)).toBe(false);
    vi.advanceTimersByTime(14 * MINUTE + 31_000);
    expect(m.tokenExpiresWithin(30_000)).toBe(true);
  });

  it('a token with exp − iat ≤ 0 counts as expired at once', async () => {
    const m = await load();
    m.setAccessToken(fakeToken({ expiresInSeconds: -60 }));

    expect(m.tokenExpiresWithin(0)).toBe(true);
  });

  it('without a token nothing expires', async () => {
    const m = await load();
    m.setAccessToken(fakeToken());
    m.setAccessToken(null);

    expect(m.tokenExpiresWithin(30_000)).toBe(false);
  });
});
