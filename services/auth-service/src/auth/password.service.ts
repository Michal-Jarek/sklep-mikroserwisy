import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';

export const BCRYPT_COST = 12;

/** bcrypt hashing. Created by a factory in AuthModule; tests pass a lower cost. */
export class PasswordService {
  // Hash of a random value, computed once at startup. A login with an unknown email is compared
  // with it, so it takes as long as a wrong password (decision 10).
  private readonly dummyHash: Promise<string>;

  constructor(private readonly cost: number = BCRYPT_COST) {
    this.dummyHash = bcrypt.hash(randomBytes(32).toString('base64url'), cost);
  }

  hash(password: string): Promise<string> {
    return bcrypt.hash(password, this.cost);
  }

  /** null = no account with this email: still runs one comparison and returns false. */
  async verify(password: string, passwordHash: string | null): Promise<boolean> {
    const matches = await bcrypt.compare(password, passwordHash ?? (await this.dummyHash));
    return passwordHash !== null && matches;
  }
}
