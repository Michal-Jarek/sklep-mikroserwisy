import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';

// 7 days, the same value as Max-Age of the cookie (decision 17).
export const REFRESH_TOKEN_TTL_SECONDS = 604_800;

// 32 random bytes in base64url (no padding) are always 43 characters.
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 (hex) of the cookie value. Only the hash is stored, so a database leak does not reveal tokens. */
export function hashRefreshToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface RotatedRefreshToken {
  accountId: string;
  // Roles read from the database, not from the previous access token.
  roles: string[];
  // New cookie value.
  token: string;
}

function unauthorized(): AppException {
  return new AppException(401, 'UNAUTHORIZED', 'Invalid or expired refresh token');
}

/**
 * Refresh tokens with rotation (decision 17). Every token belongs to a family that starts at login.
 * A refresh replaces the token with a new one in the same family; presenting a replaced (revoked)
 * token again means it was copied, so the whole family is revoked. Values and hashes are never logged.
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(RefreshTokenService.name) private readonly logger: PinoLogger,
  ) {}

  /** New family (login). Returns the cookie value. */
  async issue(accountId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({ data: this.newRow(accountId, randomUUID(), randomUUID(), token) });
    return token;
  }

  /**
   * Replaces the token with a new one in the same family. 401 UNAUTHORIZED when the value is missing,
   * unknown, expired or revoked; a revoked token (also one that lost a race with a parallel refresh)
   * revokes the family first.
   */
  async rotate(value: string | undefined): Promise<RotatedRefreshToken> {
    const current = await this.find(value);
    if (!current) {
      throw unauthorized();
    }
    if (current.revokedAt !== null) {
      await this.revokeReusedFamily(current.accountId, current.familyId);
      throw unauthorized();
    }
    if (current.expiresAt.getTime() <= Date.now()) {
      throw unauthorized();
    }

    const successorId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const rotated = await this.prisma.$transaction(async (tx) => {
      // Conditional update: of two parallel refreshes with the same token only one revokes it (count 1).
      const { count } = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: successorId },
      });
      if (count !== 1) {
        return false;
      }
      await tx.refreshToken.create({ data: this.newRow(current.accountId, current.familyId, successorId, token) });
      return true;
    });
    if (!rotated) {
      // Another request has just rotated this token: the same value was used twice.
      await this.revokeReusedFamily(current.accountId, current.familyId);
      throw unauthorized();
    }
    return { accountId: current.accountId, roles: current.account.roles, token };
  }

  /** Logout: revokes the family of the token. Missing or unknown token: nothing to do. Returns the account id. */
  async revokeFamily(value: string | undefined): Promise<string | null> {
    const current = await this.find(value);
    if (!current) {
      return null;
    }
    await this.revokeFamilyRows(current.familyId);
    return current.accountId;
  }

  // A value that cannot be a token (empty, garbage) is rejected without a database query.
  private async find(value: string | undefined) {
    if (value === undefined || !REFRESH_TOKEN_PATTERN.test(value)) {
      return null;
    }
    return this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(value) },
      include: { account: { select: { roles: true } } },
    });
  }

  private async revokeReusedFamily(accountId: string, familyId: string): Promise<void> {
    await this.revokeFamilyRows(familyId);
    this.logger.warn({ userId: accountId, familyId }, 'Refresh token reuse detected, token family revoked');
  }

  private revokeFamilyRows(familyId: string) {
    return this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  // created_at and expires_at from the same moment, so the lifetime is exactly 604800 s.
  private newRow(accountId: string, familyId: string, id: string, token: string) {
    const createdAt = new Date();
    return {
      id,
      accountId,
      familyId,
      tokenHash: hashRefreshToken(token),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    };
  }
}
