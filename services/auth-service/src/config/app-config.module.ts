import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './app-config';

/** Makes the configuration loaded in main.ts available everywhere as APP_CONFIG. */
@Global()
@Module({})
export class AppConfigModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
