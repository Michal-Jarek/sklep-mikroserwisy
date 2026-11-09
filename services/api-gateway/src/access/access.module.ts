import { Module } from '@nestjs/common';
import { ConsulModule } from '../consul/consul.module';
import { AccessControl } from './access-control.service';
import { JwksProvider } from './jwks-provider.service';

@Module({
  imports: [ConsulModule],
  providers: [AccessControl, JwksProvider],
  exports: [AccessControl],
})
export class AccessModule {}
