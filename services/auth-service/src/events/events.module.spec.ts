import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { pino } from 'pino';
import { loggerModuleParams } from '../common/logger';
import { buildConfig, KV_DEFAULTS } from '../config/app-config';
import { AppConfigModule } from '../config/app-config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AmqpPublisher } from './amqp-publisher.service';
import { userRegisteredEvent } from './event-envelope';
import { EventsModule } from './events.module';
import { OutboxRelay } from './outbox-relay.service';

const ENV = {
  DB_HOST: 'postgres',
  DB_NAME: 'auth_db',
  DB_USER: 'auth_service',
  DB_PASSWORD: 'test-password',
  RABBITMQ_HOST: 'rabbitmq',
  RABBITMQ_USER: 'auth-service',
  RABBITMQ_PASSWORD: 'test-rabbitmq-password',
};

/**
 * Shutdown order in Nest: onModuleDestroy runs for normal modules before global ones, so the relay
 * finishes its cycle and closes RabbitMQ before PrismaService (global module) disconnects.
 */
describe('EventsModule shutdown order', () => {
  it('the running cycle ends and RabbitMQ closes before Prisma disconnects', async () => {
    const order: string[] = [];
    const event = userRegisteredEvent({ userId: 'user-1', email: 'anna@example.com', firstName: 'Anna' }, 'req-1');
    let confirm: () => void = () => undefined;
    const prisma = {
      $queryRaw: () => Promise.resolve([{ id: event.eventId, routing_key: event.type, envelope: event, attempts: 1 }]),
      $executeRaw: () => {
        order.push('outbox row updated');
        return Promise.resolve(1);
      },
      onModuleDestroy: () => {
        order.push('prisma disconnected');
        return Promise.resolve();
      },
    };
    const publisher = {
      start: (onReady: () => void) => {
        onReady();
        return Promise.resolve();
      },
      canPublish: () => true,
      awaitsAnswer: () => false,
      publish: () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        }),
      close: jest.fn(() => {
        order.push('rabbitmq closed');
        return Promise.resolve();
      }),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.register(buildConfig(ENV, KV_DEFAULTS)),
        LoggerModule.forRoot(loggerModuleParams(pino({ level: 'silent' }))),
        PrismaModule,
        EventsModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AmqpPublisher)
      .useValue(publisher)
      .compile();
    await moduleRef.init();
    expect(moduleRef.get(OutboxRelay)).toBeInstanceOf(OutboxRelay);
    // The cycle started by the connection waits for the broker confirmation.
    await new Promise((resolve) => setImmediate(resolve));

    const closing = moduleRef.close();
    setTimeout(() => confirm(), 50);
    await closing;

    expect(order).toEqual(['outbox row updated', 'rabbitmq closed', 'prisma disconnected']);
  });
});
