import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Decision 19: the 10th failed login in a row locks the email for 15 minutes.
export const MAX_FAILED_LOGINS = 10;
export const LOCK_SECONDS = 900;

/**
 * Failed logins per normalized email (table login_failures), also for emails without an account,
 * so the answer does not reveal whether an account exists. Times come from the database clock.
 */
@Injectable()
export class LoginAttemptsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Seconds until the lock ends (1-900, rounded up), or null when the email is not locked. */
  async lockedForSeconds(email: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ seconds: number }[]>`
      SELECT ceil(extract(epoch FROM locked_until - now()))::int AS seconds
      FROM login_failures
      WHERE email = ${email} AND locked_until > now()`;
    if (rows.length === 0) {
      return null;
    }
    return Math.min(Math.max(rows[0].seconds, 1), LOCK_SECONDS);
  }

  /**
   * Counts one failed login in a single statement (safe with parallel requests). The 10th failure
   * sets locked_until = now() + 15 min and the counter back to 0; failures while locked are not
   * counted (requests that passed the lock check just before the lock was set).
   * Returns true when this failure locked the email.
   */
  async recordFailure(email: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ locked_now: boolean }[]>`
      INSERT INTO login_failures AS f (email, failed_count, updated_at)
      VALUES (${email}, 1, now())
      ON CONFLICT (email) DO UPDATE SET
        failed_count = CASE
          WHEN f.locked_until > now() THEN f.failed_count
          WHEN f.failed_count + 1 >= ${MAX_FAILED_LOGINS} THEN 0
          ELSE f.failed_count + 1
        END,
        locked_until = CASE
          WHEN f.locked_until > now() THEN f.locked_until
          WHEN f.failed_count + 1 >= ${MAX_FAILED_LOGINS} THEN now() + make_interval(secs => ${LOCK_SECONDS})
          ELSE f.locked_until
        END,
        updated_at = now()
      RETURNING f.locked_until IS NOT NULL
        AND f.locked_until = now() + make_interval(secs => ${LOCK_SECONDS}) AS locked_now`;
    // now() is fixed for the statement, so only a lock set by this statement matches exactly.
    return rows[0]?.locked_now === true;
  }

  /** Successful login: the counter and any expired lock are removed. */
  async clear(email: string): Promise<void> {
    await this.prisma.loginFailure.deleteMany({ where: { email } });
  }
}
