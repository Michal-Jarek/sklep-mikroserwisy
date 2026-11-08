import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { describeError } from '../consul/consul-http';
import { PrismaService } from '../prisma/prisma.service';

/** Ready for traffic when the database answers SELECT 1. Consul is not required. */
@Injectable()
export class Readiness {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(Readiness.name) private readonly logger: PinoLogger,
  ) {}

  async check(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.warn({ reason: describeError(error) }, 'Database is not reachable');
      return false;
    }
  }
}
