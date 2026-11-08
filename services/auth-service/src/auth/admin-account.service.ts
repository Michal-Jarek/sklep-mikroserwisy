import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { isUniqueViolation, prismaErrorCode } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';
import { ROLE_ADMIN } from './auth.service';
import { PasswordService } from './password.service';

/**
 * Creates the first ADMIN account at startup from ADMIN_EMAIL and ADMIN_PASSWORD (decision 16).
 * An existing account is left as it is (the password is not changed). No profile in User Service.
 * Never stops the startup: on a database error the account is created at the next start.
 */
@Injectable()
export class AdminAccountInitializer implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(AdminAccountInitializer.name) private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const admin = this.config.admin;
    if (!admin) {
      this.logger.info('ADMIN_EMAIL and ADMIN_PASSWORD are not set, the admin account is not created');
      return;
    }
    try {
      const existing = await this.prisma.account.findUnique({ where: { email: admin.email }, select: { id: true } });
      if (existing) {
        this.logger.info({ userId: existing.id }, 'Admin account already exists');
        return;
      }
      const id = randomUUID();
      const passwordHash = await this.passwords.hash(admin.password);
      await this.prisma.account.create({ data: { id, email: admin.email, passwordHash, roles: [ROLE_ADMIN] } });
      this.logger.info({ userId: id }, 'Admin account created');
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Another instance started at the same time and created it first.
        this.logger.info('Admin account already exists (created by another instance)');
        return;
      }
      // Only the error type: database messages can contain the email.
      this.logger.error(
        { errorName: error instanceof Error ? error.name : typeof error, errorCode: prismaErrorCode(error) },
        'Could not create the admin account, it will be created at the next start',
      );
    }
  }
}
