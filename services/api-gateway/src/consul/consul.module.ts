import { Module } from '@nestjs/common';
import { ConsulRegistration } from './consul-registration.service';
import { ServiceDiscovery } from './service-discovery.service';

@Module({
  providers: [ConsulRegistration, ServiceDiscovery],
  exports: [ConsulRegistration, ServiceDiscovery],
})
export class ConsulModule {}
