import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AppException } from '../common/app-exception';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { userRegisteredEvent } from '../events/event-envelope';
import { OutboxRelay } from '../events/outbox-relay.service';
import { isUniqueViolation } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { UserClient } from '../user-client/user-client.service';
import type { LoginRequest, LoginResponse, RegisterRequest, RegisterResponse } from './auth.dto';
import { LoginAttemptsService } from './login-attempts.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { ACCESS_TOKEN_TTL_SECONDS, TokenService } from './token.service';

export const ROLE_CUSTOMER = 'CUSTOMER';
export const ROLE_ADMIN = 'ADMIN';

// Covers two User Service attempts (2 x 2 s), the retry delay and the Consul lookup (Prisma default: 5 s).
export const REGISTRATION_TRANSACTION_TIMEOUT_MS = 10_000;

/** Login and refresh result: the response body and the refresh token for the cookie (never in the body). */
export interface Session {
  response: LoginResponse;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly loginAttempts: LoginAttemptsService,
    private readonly userClient: UserClient,
    private readonly outbox: OutboxRelay,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Account and user profile in one transaction (decision 13): the account is committed only
   * when User Service created the profile, otherwise it is rolled back and the client gets 503.
   * The user.registered event goes to the outbox in the same transaction (stage 4) and the relay
   * publishes it after the commit, so registration never waits for RabbitMQ.
   */
  async register(request: RegisterRequest, requestId: string): Promise<RegisterResponse> {
    const { email, password, firstName, lastName } = request;
    const id = randomUUID();
    const passwordHash = await this.passwords.hash(password);
    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.account.create({ data: { id, email, passwordHash, roles: [ROLE_CUSTOMER] } });
          this.logger.assign({ userId: id });
          const event = userRegisteredEvent({ userId: id, email, firstName }, requestId);
          await tx.outboxEvent.create({ data: { id: event.eventId, routingKey: event.type, envelope: event } });
          if (this.config.userServiceEnabled) {
            await this.userClient.createProfile({ id, email, firstName, lastName }, requestId);
          }
        },
        { timeout: REGISTRATION_TRANSACTION_TIMEOUT_MS },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Not logged: the database message contains the email. User Service was not called.
        throw new AppException(409, 'EMAIL_TAKEN', 'Email is already registered');
      }
      throw error;
    }
    // Committed: publish now instead of at the next 5 s cycle (does not wait, never throws).
    this.outbox.wake();
    if (!this.config.userServiceEnabled) {
      this.logger.warn('User Service call is disabled (USER_SERVICE_ENABLED=false), the user profile was not created');
    }
    return { id, email, firstName, lastName, roles: [ROLE_CUSTOMER] };
  }

  /**
   * Order (decision 19): the IP limit runs before (route hook), then the account lock, then the password.
   * While locked: 429 TOO_MANY_ATTEMPTS without a bcrypt comparison and without counting.
   * Wrong password and unknown email give the same 401 after the same bcrypt work (decision 10)
   * and are counted the same way, per normalized email.
   */
  async login(request: LoginRequest): Promise<Session> {
    const lockedForSeconds = await this.loginAttempts.lockedForSeconds(request.email);
    if (lockedForSeconds !== null) {
      throw new AppException(429, 'TOO_MANY_ATTEMPTS', 'Too many failed login attempts, try again later', lockedForSeconds);
    }
    const account = await this.prisma.account.findUnique({ where: { email: request.email } });
    const valid = await this.passwords.verify(request.password, account?.passwordHash ?? null);
    if (!account || !valid) {
      if (await this.loginAttempts.recordFailure(request.email)) {
        // No email in logs: the user id when the account exists, otherwise nothing.
        this.logger.warn(account ? { userId: account.id } : {}, 'Login locked for 15 minutes after 10 failed attempts');
      }
      throw new AppException(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    this.logger.assign({ userId: account.id });
    await this.loginAttempts.clear(request.email);
    return this.session(account.id, account.roles, await this.refreshTokens.issue(account.id));
  }

  /** New access token (roles from the database) and a rotated refresh token. 401 UNAUTHORIZED otherwise. */
  async refresh(refreshToken: string | undefined): Promise<Session> {
    const rotated = await this.refreshTokens.rotate(refreshToken);
    this.logger.assign({ userId: rotated.accountId });
    return this.session(rotated.accountId, rotated.roles, rotated.token);
  }

  /** Revokes the token family when the token is known. Never fails for a missing or unknown token. */
  async logout(refreshToken: string | undefined): Promise<void> {
    const accountId = await this.refreshTokens.revokeFamily(refreshToken);
    if (accountId !== null) {
      this.logger.assign({ userId: accountId });
    }
  }

  private async session(accountId: string, roles: string[], refreshToken: string): Promise<Session> {
    const accessToken = await this.tokens.issueAccessToken(accountId, roles);
    return { response: { accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS }, refreshToken };
  }
}
