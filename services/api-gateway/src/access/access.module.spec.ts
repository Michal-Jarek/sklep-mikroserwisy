import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { pino } from 'pino';
import { loggerModuleParams } from '../common/logger';
import { buildAppConfig } from '../config/app-config';
import { AppConfigModule } from '../config/app-config.module';
import { MetricsModule } from '../metrics/metrics.module';
import { AccessControl } from './access-control.service';
import { AccessModule } from './access.module';
import { JwksProvider } from './jwks-provider.service';

describe('AccessModule', () => {
  it('wires AccessControl and JwksProvider (configuration state, discovery and loggers injected)', async () => {
    // compile() only creates the providers: no lifecycle hook runs, so nothing calls Consul or Auth.
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.register(buildAppConfig({ CONSUL_HOST: 'consul', REDIS_PASSWORD: 'test-redis' })),
        LoggerModule.forRoot(loggerModuleParams(pino({ level: 'silent' }))),
        // Global like in AppModule: ServiceDiscovery sets gateway_upstream_instances.
        MetricsModule,
        AccessModule,
      ],
    }).compile();

    expect(moduleRef.get(AccessControl)).toBeInstanceOf(AccessControl);
    expect(moduleRef.get(JwksProvider, { strict: false })).toBeInstanceOf(JwksProvider);
  });
});
