import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './app-config';
import { GatewayConfigState } from './gateway-config-state.service';

/**
 * Makes the static configuration (APP_CONFIG, from main.ts) and the state of the KV configuration
 * (GatewayConfigState, current() is null until loaded) available everywhere.
 */
@Global()
@Module({})
export class AppConfigModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }, GatewayConfigState],
      exports: [APP_CONFIG, GatewayConfigState],
    };
  }
}
