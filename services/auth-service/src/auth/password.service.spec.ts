import { jest } from '@jest/globals';
import bcrypt from 'bcrypt';
import { BCRYPT_COST, PasswordService } from './password.service';

describe('PasswordService', () => {
  // Low cost in tests only; production uses 12.
  const passwords = new PasswordService(4);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses cost 12 by default', () => {
    expect(BCRYPT_COST).toBe(12);
  });

  it('hashes with bcrypt ($2b$) and verifies the right password only', async () => {
    const hash = await passwords.hash('correct-horse-42');
    expect(hash).toMatch(/^\$2b\$04\$/);
    expect(await passwords.verify('correct-horse-42', hash)).toBe(true);
    expect(await passwords.verify('wrong-password', hash)).toBe(false);
  });

  it('compares with the dummy hash when there is no account and returns false', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');
    expect(await passwords.verify('correct-horse-42', null)).toBe(false);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0][1]).toMatch(/^\$2b\$04\$/);
  });
});
