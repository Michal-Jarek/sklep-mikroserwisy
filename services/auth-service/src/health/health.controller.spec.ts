import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import type { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';
import { Readiness } from './readiness.service';

function createController(queryRaw: () => Promise<unknown>) {
  const prisma = { $queryRaw: jest.fn(queryRaw) };
  const logger = { warn: jest.fn() };
  const readiness = new Readiness(prisma as unknown as PrismaService, logger as unknown as PinoLogger);
  return { controller: new HealthController(readiness), prisma, logger };
}

describe('HealthController', () => {
  it('live does not touch the database', () => {
    const { controller, prisma } = createController(() => Promise.resolve([]));
    expect(controller.live()).toEqual({ status: 'UP' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('ready is UP when the database answers SELECT 1', async () => {
    const { controller, prisma } = createController(() => Promise.resolve([{ '?column?': 1 }]));
    await expect(controller.ready()).resolves.toEqual({ status: 'UP' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('ready fails with 503 SERVICE_UNAVAILABLE when the database does not answer', async () => {
    const { controller, logger } = createController(() => Promise.reject(new Error('connect ECONNREFUSED')));
    const result = controller.ready();
    await expect(result).rejects.toBeInstanceOf(AppException);
    await expect(result).rejects.toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
