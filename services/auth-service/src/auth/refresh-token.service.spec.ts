import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { createHash } from 'node:crypto';
import { AppException } from '../common/app-exception';
import type { PrismaService } from '../prisma/prisma.service';
import { hashRefreshToken, REFRESH_TOKEN_TTL_SECONDS, RefreshTokenService } from './refresh-token.service';

interface Row {
  id: string;
  accountId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  createdAt: Date;
}

interface Where {
  id?: string;
  familyId?: string;
  revokedAt?: null;
}

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

/** In-memory refresh_tokens and accounts. findUnique returns a copy, like a real query. */
function fakePrisma(roles: Record<string, string[]> = { 'account-1': ['CUSTOMER'] }) {
  const rows: Row[] = [];
  const matches = (row: Row, where: Where) =>
    (where.id === undefined || row.id === where.id) &&
    (where.familyId === undefined || row.familyId === where.familyId) &&
    (where.revokedAt === undefined || row.revokedAt === null);
  const refreshToken = {
    create: jest.fn(({ data }: { data: Omit<Row, 'revokedAt' | 'replacedById'> }) => {
      const row = { ...data, revokedAt: null, replacedById: null };
      rows.push(row);
      return Promise.resolve({ ...row });
    }),
    findUnique: jest.fn(({ where }: { where: { tokenHash: string } }) => {
      const row = rows.find((r) => r.tokenHash === where.tokenHash);
      const account = row ? roles[row.accountId] : undefined;
      return Promise.resolve(row && account ? { ...row, account: { roles: account } } : null);
    }),
    updateMany: jest.fn(({ where, data }: { where: Where; data: Partial<Row> }) => {
      const matched = rows.filter((row) => matches(row, where));
      matched.forEach((row) => Object.assign(row, data));
      return Promise.resolve({ count: matched.length });
    }),
  };
  const prisma = {
    refreshToken,
    $transaction: <T>(fn: (tx: { refreshToken: typeof refreshToken }) => Promise<T>) => fn({ refreshToken }),
  };
  return { prisma: prisma as unknown as PrismaService, rows, refreshToken };
}

describe('RefreshTokenService', () => {
  const logger = { warn: jest.fn() };

  function createService(roles?: Record<string, string[]>) {
    const db = fakePrisma(roles);
    const service = new RefreshTokenService(db.prisma, logger as unknown as PinoLogger);
    return { service, ...db };
  }

  async function expectUnauthorized(promise: Promise<unknown>): Promise<void> {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('hashRefreshToken: SHA-256 in hex (64 characters), never the value itself', () => {
    const value = 'A'.repeat(43);
    expect(hashRefreshToken(value)).toBe(createHash('sha256').update(value).digest('hex'));
    expect(hashRefreshToken(value)).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('issue', () => {
    it('stores only the hash, with a lifetime of exactly 604800 s, in a new family', async () => {
      const { service, rows } = createService();

      const token = await service.issue('account-1');
      const second = await service.issue('account-1');

      expect(token).toMatch(BASE64URL_32_BYTES);
      expect(rows).toHaveLength(2);
      expect(rows[0].tokenHash).toBe(hashRefreshToken(token));
      expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows)).not.toContain(token);
      expect((rows[0].expiresAt.getTime() - rows[0].createdAt.getTime()) / 1000).toBe(REFRESH_TOKEN_TTL_SECONDS);
      expect(rows[0]).toMatchObject({ accountId: 'account-1', revokedAt: null, replacedById: null });
      expect(second).not.toBe(token);
      expect(rows[1].familyId).not.toBe(rows[0].familyId);
    });
  });

  describe('rotate', () => {
    it('replaces the token with a new one in the same family and marks the old one', async () => {
      const { service, rows } = createService({ 'account-1': ['ADMIN'] });
      const token = await service.issue('account-1');

      const rotated = await service.rotate(token);

      expect(rotated).toEqual({ accountId: 'account-1', roles: ['ADMIN'], token: expect.stringMatching(BASE64URL_32_BYTES) });
      expect(rotated.token).not.toBe(token);
      const [old, successor] = rows;
      expect(successor.tokenHash).toBe(hashRefreshToken(rotated.token));
      expect(successor.familyId).toBe(old.familyId);
      expect(successor.revokedAt).toBeNull();
      expect(old.revokedAt).toBeInstanceOf(Date);
      expect(old.replacedById).toBe(successor.id);
      expect((successor.expiresAt.getTime() - successor.createdAt.getTime()) / 1000).toBe(REFRESH_TOKEN_TTL_SECONDS);
    });

    it('401 for a missing value, garbage (without a query) and an unknown token', async () => {
      const { service, refreshToken } = createService();

      await expectUnauthorized(service.rotate(undefined));
      await expectUnauthorized(service.rotate('garbage'));
      expect(refreshToken.findUnique).not.toHaveBeenCalled();
      await expectUnauthorized(service.rotate('A'.repeat(43)));
      expect(refreshToken.findUnique).toHaveBeenCalledTimes(1);
    });

    it('401 for an expired token, without revoking the family', async () => {
      const { service, rows, refreshToken } = createService();
      const token = await service.issue('account-1');
      rows[0].expiresAt = new Date(Date.now() - 1000);

      await expectUnauthorized(service.rotate(token));

      expect(refreshToken.updateMany).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('401 when the account was deleted (its tokens are deleted by the cascade)', async () => {
      const { service, rows } = createService();
      const token = await service.issue('account-1');
      rows.length = 0;

      await expectUnauthorized(service.rotate(token));
    });

    it('reuse of a replaced token revokes the whole family and logs a warning without the token', async () => {
      const { service, rows } = createService();
      const first = await service.issue('account-1');
      const other = await service.issue('account-1');
      const second = (await service.rotate(first)).token;

      await expectUnauthorized(service.rotate(first));
      await expectUnauthorized(service.rotate(second));

      const family = rows.filter((row) => row.familyId === rows[0].familyId);
      expect(family).toHaveLength(2);
      expect(family.every((row) => row.revokedAt !== null)).toBe(true);
      // Another login (another family) is not affected.
      await expect(service.rotate(other)).resolves.toMatchObject({ accountId: 'account-1' });
      expect(logger.warn).toHaveBeenCalledWith({ userId: 'account-1', familyId: rows[0].familyId }, expect.any(String));
      const logged = JSON.stringify(logger.warn.mock.calls);
      for (const value of [first, second, hashRefreshToken(first), hashRefreshToken(second)]) {
        expect(logged).not.toContain(value);
      }
    });

    it('a token revoked between the read and the update (lost race) is treated as reuse', async () => {
      const { service, rows, refreshToken } = createService();
      const token = await service.issue('account-1');
      const winner = await service.issue('account-1');
      rows[1].familyId = rows[0].familyId;
      // A parallel refresh revokes the token right after this request has read it.
      refreshToken.findUnique.mockImplementationOnce(({ where }) => {
        const row = rows.find((r) => r.tokenHash === where.tokenHash)!;
        const snapshot = { ...row, account: { roles: ['CUSTOMER'] } };
        row.revokedAt = new Date();
        row.replacedById = rows[1].id;
        return Promise.resolve(snapshot);
      });

      await expectUnauthorized(service.rotate(token));

      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      await expectUnauthorized(service.rotate(winner));
    });

    it('two parallel refreshes with the same token never both succeed', async () => {
      const { service, rows } = createService();
      const token = await service.issue('account-1');

      const results = await Promise.allSettled([service.rotate(token), service.rotate(token)]);

      const succeeded = results.filter((result) => result.status === 'fulfilled');
      expect(succeeded.length).toBeLessThanOrEqual(1);
      expect(results.some((result) => result.status === 'rejected')).toBe(true);
      // The family is revoked, so the token of the winner (if any) does not work either.
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
      for (const result of succeeded) {
        await expectUnauthorized(service.rotate(result.value.token));
      }
    });
  });

  describe('revokeFamily (logout)', () => {
    it('revokes every token of the family and returns the account id', async () => {
      const { service, rows } = createService();
      const first = await service.issue('account-1');
      const second = (await service.rotate(first)).token;

      await expect(service.revokeFamily(second)).resolves.toBe('account-1');

      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
      await expectUnauthorized(service.rotate(second));
    });

    it('does nothing for a missing, garbage or unknown token', async () => {
      const { service, refreshToken } = createService();

      await expect(service.revokeFamily(undefined)).resolves.toBeNull();
      await expect(service.revokeFamily('')).resolves.toBeNull();
      await expect(service.revokeFamily('B'.repeat(43))).resolves.toBeNull();

      expect(refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });
});
