import { jest } from '@jest/globals';
import type { PrismaService } from '../prisma/prisma.service';
import { LOCK_SECONDS, LoginAttemptsService, MAX_FAILED_LOGINS } from './login-attempts.service';

const EMAIL = "o'brien@example.com";

// The SQL runs in PostgreSQL (stage criteria K38, E2); here: parameters and the mapping of results.
describe('LoginAttemptsService', () => {
  const queryRaw = jest.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>();
  const deleteMany = jest.fn<(args: unknown) => Promise<{ count: number }>>();
  const service = new LoginAttemptsService({
    $queryRaw: queryRaw,
    loginFailure: { deleteMany },
  } as unknown as PrismaService);

  function lastQuery() {
    const [strings, ...values] = queryRaw.mock.calls[queryRaw.mock.calls.length - 1];
    return { sql: strings.join('$?'), values };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('lockedForSeconds', () => {
    it('null when there is no lock in the future (no row or locked_until in the past)', async () => {
      queryRaw.mockResolvedValue([]);

      await expect(service.lockedForSeconds(EMAIL)).resolves.toBeNull();

      const { sql, values } = lastQuery();
      expect(sql).toContain('locked_until > now()');
      expect(values).toEqual([EMAIL]);
      expect(sql).not.toContain(EMAIL);
    });

    it('seconds until the end of the lock, kept within 1-900', async () => {
      for (const [seconds, expected] of [[120, 120], [900, 900], [0, 1], [901, 900]]) {
        queryRaw.mockResolvedValue([{ seconds }]);
        await expect(service.lockedForSeconds(EMAIL)).resolves.toBe(expected);
      }
    });
  });

  describe('recordFailure', () => {
    it('one atomic upsert with the email, the threshold and the lock length as parameters', async () => {
      queryRaw.mockResolvedValue([{ locked_now: false }]);

      await expect(service.recordFailure(EMAIL)).resolves.toBe(false);

      const { sql, values } = lastQuery();
      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(sql).toContain('ON CONFLICT (email) DO UPDATE');
      expect(sql).toContain('f.failed_count + 1');
      expect(sql).not.toContain(EMAIL);
      expect(values).toEqual([EMAIL, MAX_FAILED_LOGINS, MAX_FAILED_LOGINS, LOCK_SECONDS, LOCK_SECONDS]);
      expect([MAX_FAILED_LOGINS, LOCK_SECONDS]).toEqual([10, 900]);
    });

    it('true when this failure locked the email', async () => {
      queryRaw.mockResolvedValue([{ locked_now: true }]);
      await expect(service.recordFailure(EMAIL)).resolves.toBe(true);
    });
  });

  it('clear deletes the row of the email', async () => {
    deleteMany.mockResolvedValue({ count: 1 });

    await service.clear(EMAIL);

    expect(deleteMany).toHaveBeenCalledWith({ where: { email: EMAIL } });
  });
});
