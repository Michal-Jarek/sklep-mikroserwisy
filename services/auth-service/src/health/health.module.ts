import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { Readiness } from './readiness.service';

@Module({
  controllers: [HealthController],
  providers: [Readiness],
  exports: [Readiness],
})
export class HealthModule {}
