import { DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Logger } from 'pino';
import { AuthModule } from './auth/auth.module';
import type { SigningKey } from './auth/signing-key';
import { loggerModuleParams } from './common/logger';
import { AppConfig } from './config/app-config';
import { AppConfigModule } from './config/app-config.module';
import { ConsulModule } from './consul/consul.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({})
export class AppModule {
  /** The configuration, the logger and the signing key are created in main.ts before Nest starts. */
  static register(config: AppConfig, logger: Logger, signingKey: SigningKey): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.register(config),
        LoggerModule.forRoot(loggerModuleParams(logger)),
        PrismaModule,
        ConsulModule,
        HealthModule,
        AuthModule.register(signingKey),
      ],
    };
  }
}
