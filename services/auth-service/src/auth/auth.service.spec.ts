import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { buildConfig, KV_DEFAULTS } from '../config/app-config';
import type { PrismaService } from '../prisma/prisma.service';
import type { UserClient, UserProfile } from '../user-client/user-client.service';
import { AuthService, REGISTRATION_TRANSACTION_TIMEOUT_MS } from './auth.service';
import { LOCK_SECONDS, type LoginAttemptsService, MAX_FAILED_LOGINS } from './login-attempts.service';
import { PasswordService } from './password.service';
import type { RefreshTokenService, RotatedRefreshToken } from './refresh-token.service';
import type { TokenService } from './token.service';

const ENV = { DB_HOST: 'postgres', DB_NAME: 'auth_db', DB_USER: 'auth_service', DB_PASSWORD: 'test-password' };
const REQUEST = { email: 'anna@example.com', password: 'correct-horse-42', firstName: 'Anna', lastName: 'Nowak' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface StoredAccount {
  id: string;
  email: string;
  passwordHash: string;
  roles: string[];
}

function uniqueViolation(): Error {
  return Object.assign(new Error('Unique constraint failed on the fields: (`email`)'), { code: 'P2002' });
}

/** In-memory "database" with an interactive transaction that commits or rolls back. */
function fakePrisma() {
  const committed: StoredAccount[] = [];
  const state = { rolledBack: false, timeout: 0 };
  const create = jest.fn(({ data }: { data: StoredAccount }, pending: StoredAccount[]) => {
    if ([...committed, ...pending].some((account) => account.email === data.email)) {
      return Promise.reject(uniqueViolation());
    }
    pending.push(data);
    return Promise.resolve(data);
  });
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<void>, options: { timeout: number }) => {
      state.timeout = options.timeout;
      const pending: StoredAccount[] = [];
      const tx = { account: { create: (args: { data: StoredAccount }) => create(args, pending) } };
      try {
        await fn(tx);
      } catch (error) {
        state.rolledBack = true;
        throw error;
      }
      committed.push(...pending);
    },
    account: {
      findUnique: ({ where }: { where: { email: string } }) =>
        Promise.resolve(committed.find((account) => account.email === where.email) ?? null),
    },
  };
  return { prisma: prisma as unknown as PrismaService, committed, state, create };
}

/**
 * In-memory login_failures with the rules of the SQL in LoginAttemptsService (decision 19);
 * the SQL itself is checked against PostgreSQL in the stage criteria (K38, E2).
 */
function fakeLoginAttempts() {
  const rows = new Map<string, { failedCount: number; lockedUntil: number | null }>();
  const isLocked = (email: string) => {
    const lockedUntil = rows.get(email)?.lockedUntil ?? null;
    return lockedUntil !== null && lockedUntil > Date.now();
  };
  const attempts = {
    lockedForSeconds: jest.fn((email: string) =>
      Promise.resolve(isLocked(email) ? Math.ceil((rows.get(email)!.lockedUntil! - Date.now()) / 1000) : null),
    ),
    recordFailure: jest.fn((email: string) => {
      if (isLocked(email)) {
        return Promise.resolve(false);
      }
      const row = rows.get(email) ?? { failedCount: 0, lockedUntil: null };
      row.failedCount += 1;
      const lockedNow = row.failedCount >= MAX_FAILED_LOGINS;
      if (lockedNow) {
        row.failedCount = 0;
        row.lockedUntil = Date.now() + LOCK_SECONDS * 1000;
      }
      rows.set(email, row);
      return Promise.resolve(lockedNow);
    }),
    clear: jest.fn((email: string) => {
      rows.delete(email);
      return Promise.resolve();
    }),
  };
  return { attempts, rows };
}

describe('AuthService', () => {
  const passwords = new PasswordService(4);
  const logger = { assign: jest.fn(), warn: jest.fn(), info: jest.fn() };
  const createProfile = jest.fn<(profile: UserProfile, requestId: string) => Promise<void>>();
  const issueAccessToken = jest.fn<(id: string, roles: string[]) => Promise<string>>();
  const issue = jest.fn<(accountId: string) => Promise<string>>();
  const rotate = jest.fn<(value: string | undefined) => Promise<RotatedRefreshToken>>();
  const revokeFamily = jest.fn<(value: string | undefined) => Promise<string | null>>();

  function createService(env: Record<string, string> = ENV) {
    const db = fakePrisma();
    const { attempts, rows } = fakeLoginAttempts();
    const service = new AuthService(
      db.prisma,
      passwords,
      { issueAccessToken } as unknown as TokenService,
      { issue, rotate, revokeFamily } as unknown as RefreshTokenService,
      attempts as unknown as LoginAttemptsService,
      { createProfile } as unknown as UserClient,
      buildConfig(env, KV_DEFAULTS),
      logger as unknown as PinoLogger,
    );
    return { service, attempts, failures: rows, ...db };
  }

  function resetMocks(): void {
    jest.clearAllMocks();
    createProfile.mockResolvedValue(undefined);
    issueAccessToken.mockResolvedValue('signed.jwt.token');
    issue.mockResolvedValue('refresh-token-value');
  }

  beforeEach(resetMocks);

  describe('register', () => {
    it('stores the account and creates the profile in User Service in one transaction', async () => {
      const { service, committed, state } = createService();

      const result = await service.register(REQUEST, 'req-1');

      expect(result).toEqual({ id: expect.stringMatching(UUID), email: REQUEST.email, firstName: 'Anna', lastName: 'Nowak', roles: ['CUSTOMER'] });
      expect(createProfile).toHaveBeenCalledWith(
        { id: result.id, email: REQUEST.email, firstName: 'Anna', lastName: 'Nowak' },
        'req-1',
      );
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({ id: result.id, email: REQUEST.email, roles: ['CUSTOMER'] });
      expect(await passwords.verify(REQUEST.password, committed[0].passwordHash)).toBe(true);
      expect(state.timeout).toBe(REGISTRATION_TRANSACTION_TIMEOUT_MS);
      expect(logger.assign).toHaveBeenCalledWith({ userId: result.id });
    });

    it('returns 409 EMAIL_TAKEN without calling User Service and without logging', async () => {
      const { service } = createService();
      await service.register(REQUEST, 'req-1');
      createProfile.mockClear();

      const error = await service.register({ ...REQUEST, firstName: 'Other' }, 'req-2').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AppException);
      expect(error).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
      expect(createProfile).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('rolls the account back and returns 503 when User Service fails', async () => {
      const { service, committed, state } = createService();
      createProfile.mockRejectedValue(new AppException(503, 'SERVICE_UNAVAILABLE', 'User Service is unavailable'));

      const error = await service.register(REQUEST, 'req-1').catch((e: unknown) => e);

      expect(error).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
      expect(state.rolledBack).toBe(true);
      expect(committed).toHaveLength(0);
    });

    it('skips User Service when USER_SERVICE_ENABLED=false and warns without the email', async () => {
      const { service, committed } = createService({ ...ENV, USER_SERVICE_ENABLED: 'false' });

      const result = await service.register(REQUEST, 'req-1');

      expect(createProfile).not.toHaveBeenCalled();
      expect(committed).toHaveLength(1);
      expect(logger.assign).toHaveBeenCalledWith({ userId: result.id });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(REQUEST.email);
    });
  });

  describe('login', () => {
    async function registered() {
      const db = createService({ ...ENV, USER_SERVICE_ENABLED: 'false' });
      const account = await db.service.register(REQUEST, 'req-1');
      resetMocks();
      return { ...db, account };
    }

    const WRONG = { email: REQUEST.email, password: 'wrong-password' };
    const RIGHT = { email: REQUEST.email, password: REQUEST.password };

    async function failTimes(service: AuthService, times: number, request = WRONG) {
      for (let i = 0; i < times; i += 1) {
        await expect(service.login(request)).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
      }
    }

    it('returns an access token and a new refresh token family for the right password', async () => {
      const { service, account } = await registered();

      const result = await service.login(RIGHT);

      expect(result).toEqual({
        response: { accessToken: 'signed.jwt.token', tokenType: 'Bearer', expiresIn: 900 },
        refreshToken: 'refresh-token-value',
      });
      expect(issueAccessToken).toHaveBeenCalledWith(account.id, ['CUSTOMER']);
      expect(issue).toHaveBeenCalledWith(account.id);
      expect(logger.assign).toHaveBeenCalledWith({ userId: account.id });
    });

    it('does not lock after 9 failed logins', async () => {
      const { service, failures } = await registered();

      await failTimes(service, 9);

      expect(failures.get(REQUEST.email)).toEqual({ failedCount: 9, lockedUntil: null });
      await expect(service.login(RIGHT)).resolves.toMatchObject({ refreshToken: 'refresh-token-value' });
    });

    it('locks for 15 minutes at the 10th failed login (still 401) and resets the counter', async () => {
      const { service, failures } = await registered();

      await failTimes(service, 10);

      const row = failures.get(REQUEST.email);
      expect(row?.failedCount).toBe(0);
      expect(row?.lockedUntil).toBeGreaterThan(Date.now() + (LOCK_SECONDS - 5) * 1000);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toEqual({ userId: expect.any(String) });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(REQUEST.email);
    });

    it('while locked: 429 TOO_MANY_ATTEMPTS with Retry-After 1-900, no bcrypt, no counting, also for the right password', async () => {
      const { service, attempts } = await registered();
      await failTimes(service, 10);
      const verify = jest.spyOn(passwords, 'verify');
      attempts.recordFailure.mockClear();

      for (const request of [WRONG, RIGHT]) {
        const error = await service.login(request).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AppException);
        expect(error).toMatchObject({ status: 429, code: 'TOO_MANY_ATTEMPTS' });
        const retryAfter = (error as AppException).retryAfterSeconds ?? 0;
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(LOCK_SECONDS);
      }

      expect(verify).not.toHaveBeenCalled();
      expect(attempts.recordFailure).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled();
      verify.mockRestore();
    });

    it('a lock in the past is no lock', async () => {
      const { service, failures } = await registered();
      failures.set(REQUEST.email, { failedCount: 0, lockedUntil: Date.now() - 1000 });

      await expect(service.login(RIGHT)).resolves.toMatchObject({ refreshToken: 'refresh-token-value' });
    });

    it('a successful login removes the row', async () => {
      const { service, failures, attempts } = await registered();
      await failTimes(service, 3);

      await service.login(RIGHT);

      expect(attempts.clear).toHaveBeenCalledWith(REQUEST.email);
      expect(failures.has(REQUEST.email)).toBe(false);
    });

    it('counts an unknown email the same way and logs the lock without any identifier', async () => {
      const { service, failures } = await registered();
      const unknown = { email: 'nobody@example.com', password: 'wrong-password' };

      await failTimes(service, 10, unknown);
      const locked = await service.login(unknown).catch((e: unknown) => e);

      expect(locked).toMatchObject({ status: 429, code: 'TOO_MANY_ATTEMPTS' });
      expect(failures.get(unknown.email)?.failedCount).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith({}, expect.any(String));
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(unknown.email);
    });

    it('locks per email: another account still logs in', async () => {
      const { service } = await registered();
      await failTimes(service, 10, { email: 'nobody@example.com', password: 'wrong-password' });

      await expect(service.login(RIGHT)).resolves.toMatchObject({ refreshToken: 'refresh-token-value' });
    });

    it('gives the same 401 for a wrong password and an unknown email, both after a bcrypt comparison', async () => {
      const { service } = await registered();
      const verify = jest.spyOn(passwords, 'verify');

      const wrongPassword = await service.login({ email: REQUEST.email, password: 'wrong-password' }).catch((e: unknown) => e);
      const unknownEmail = await service.login({ email: 'nobody@example.com', password: 'wrong-password' }).catch((e: unknown) => e);

      for (const error of [wrongPassword, unknownEmail]) {
        expect(error).toBeInstanceOf(AppException);
        expect(error).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
      }
      expect(verify).toHaveBeenCalledTimes(2);
      // Unknown email: compared with the dummy hash (null = no stored hash).
      expect(verify.mock.calls[1]).toEqual(['wrong-password', null]);
      expect(issueAccessToken).not.toHaveBeenCalled();
      expect(logger.assign).not.toHaveBeenCalled();
      verify.mockRestore();
    });
  });

  describe('refresh and logout', () => {
    it('refresh: rotates the token and signs the access token with the roles from the database', async () => {
      const { service } = createService();
      rotate.mockResolvedValue({ accountId: 'account-1', roles: ['ADMIN'], token: 'new-refresh-token' });

      const result = await service.refresh('old-refresh-token');

      expect(rotate).toHaveBeenCalledWith('old-refresh-token');
      expect(issueAccessToken).toHaveBeenCalledWith('account-1', ['ADMIN']);
      expect(result).toEqual({
        response: { accessToken: 'signed.jwt.token', tokenType: 'Bearer', expiresIn: 900 },
        refreshToken: 'new-refresh-token',
      });
      expect(logger.assign).toHaveBeenCalledWith({ userId: 'account-1' });
    });

    it('refresh: passes 401 UNAUTHORIZED on without an access token', async () => {
      const { service } = createService();
      rotate.mockRejectedValue(new AppException(401, 'UNAUTHORIZED', 'Invalid or expired refresh token'));

      await expect(service.refresh(undefined)).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
      expect(issueAccessToken).not.toHaveBeenCalled();
    });

    it('logout: revokes the family of a known token; an unknown or missing token is fine', async () => {
      const { service } = createService();
      revokeFamily.mockResolvedValueOnce('account-1').mockResolvedValueOnce(null);

      await expect(service.logout('known-token')).resolves.toBeUndefined();
      await expect(service.logout(undefined)).resolves.toBeUndefined();

      expect(revokeFamily.mock.calls).toEqual([['known-token'], [undefined]]);
      expect(logger.assign).toHaveBeenCalledTimes(1);
      expect(logger.assign).toHaveBeenCalledWith({ userId: 'account-1' });
    });
  });
});
