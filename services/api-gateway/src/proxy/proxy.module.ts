import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { ConsulModule } from '../consul/consul.module';
import { LimitsModule } from '../limits/limits.module';
import { CircuitBreakers } from './circuit-breakers.service';
import { ProxyService } from './proxy.service';
import { UpstreamService } from './upstream.service';

/** Proxy of the public API to the services; the routes are registered by setupProxy(). */
@Module({
  imports: [AccessModule, ConsulModule, LimitsModule],
  providers: [ProxyService, UpstreamService, CircuitBreakers],
  exports: [ProxyService],
})
export class ProxyModule {}
