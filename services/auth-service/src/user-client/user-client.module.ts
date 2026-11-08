import { Module } from '@nestjs/common';
import { ConsulModule } from '../consul/consul.module';
import { UserClient } from './user-client.service';

@Module({
  imports: [ConsulModule],
  providers: [UserClient],
  exports: [UserClient],
})
export class UserClientModule {}
