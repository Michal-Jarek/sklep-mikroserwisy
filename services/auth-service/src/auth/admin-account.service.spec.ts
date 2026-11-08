import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { buildConfig, KV_DEFAULTS } from '../config/app-config';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminAccountInitializer } from './admin-account.service';
import { PasswordService } from './password.service';

const ENV = { DB_HOST: 'postgres', DB_NAME: 'auth_db', DB_USER: 'auth_service', DB_PASSWORD: 'test-password' };
const ADMIN_ENV = { ...ENV, ADMIN_EMAIL: ' Admin@Sklep.Local ', ADMIN_PASSWORD: 'admin-password-123' };

describe('AdminAccountInitializer', () => {
  const passwords = new PasswordService(4);
  const logger = { info: jest.fn(), error: jest.fn() };
  const findUnique = jest.fn<(args: unknown) => Promise<{ id: string } | null>>();
  const create = jest.fn<(args: { data: { id: string; email: string; passwordHash: string; roles: string[] } }) => Promise<unknown>>();

  function createInitializer(env: Record<string, string> = ADMIN_ENV) {
    const prisma = { account: { findUnique, create } } as unknown as PrismaService;
    return new AdminAccountInitializer(prisma, passwords, buildConfig(env, KV_DEFAULTS), logger as unknown as PinoLogger);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({});
  });

  it('creates an ADMIN account with the normalized email and a bcrypt hash', async () => {
    await createInitializer().onApplicationBootstrap();

    expect(findUnique).toHaveBeenCalledWith({ where: { email: 'admin@sklep.local' }, select: { id: true } });
    expect(create).toHaveBeenCalledTimes(1);
    const { data } = create.mock.calls[0][0];
    expect(data).toMatchObject({ email: 'admin@sklep.local', roles: ['ADMIN'] });
    expect(await passwords.verify('admin-password-123', data.passwordHash)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith({ userId: data.id }, 'Admin account created');
  });

  it('does nothing when the account exists (the password is not changed)', async () => {
    findUnique.mockResolvedValue({ id: 'existing-id' });
    await createInitializer().onApplicationBootstrap();
    expect(create).not.toHaveBeenCalled();
  });

  it('treats a unique violation (another instance was first) as "already exists"', async () => {
    create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    await createInitializer().onApplicationBootstrap();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Admin account already exists (created by another instance)');
  });

  it('is skipped with an info log when both variables are empty', async () => {
    await createInitializer(ENV).onApplicationBootstrap();
    expect(findUnique).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('ADMIN_EMAIL and ADMIN_PASSWORD are not set, the admin account is not created');
  });

  it('logs a database error without the email or password and does not throw', async () => {
    findUnique.mockRejectedValue(
      Object.assign(new Error("Can't reach database server, account admin@sklep.local"), { code: 'P1001' }),
    );
    await expect(createInitializer().onApplicationBootstrap()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      { errorName: 'Error', errorCode: 'P1001' },
      'Could not create the admin account, it will be created at the next start',
    );
    const logged = JSON.stringify([logger.error.mock.calls, logger.info.mock.calls]);
    expect(logged).not.toContain('admin@sklep.local');
    expect(logged).not.toContain('admin-password-123');
  });
});
