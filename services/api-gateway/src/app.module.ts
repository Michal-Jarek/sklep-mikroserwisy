import { DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Logger } from 'pino';
import { AccessModule } from './access/access.module';
import { loggerModuleParams } from './common/logger';
import type { AppConfig } from './config/app-config';
import { AppConfigModule } from './config/app-config.module';
import { ConsulModule } from './consul/consul.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { ProxyModule } from './proxy/proxy.module';

@Module({})
export class AppModule {
  /** The static configuration and the logger are created in main.ts before Nest starts. */
  static register(config: AppConfig, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.register(config),
        LoggerModule.forRoot(loggerModuleParams(logger)),
        MetricsModule,
        ConsulModule,
        HealthModule,
        AccessModule,
        ProxyModule,
      ],
    };
  }
}
