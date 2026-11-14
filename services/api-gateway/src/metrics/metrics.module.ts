import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { GatewayMetrics } from './gateway-metrics';
import { MetricsServer } from './metrics-server.service';

/**
 * Prometheus metrics (stage 9b): GatewayMetrics for the proxy, the service discovery and the circuit breakers, and
 * the metrics server started by main.ts. Global, like the configuration.
 */
@Global()
@Module({
  providers: [
    { provide: GatewayMetrics, inject: [APP_CONFIG], useFactory: (config: AppConfig) => new GatewayMetrics(config.instanceId) },
    MetricsServer,
  ],
  exports: [GatewayMetrics, MetricsServer],
})
export class MetricsModule {}
