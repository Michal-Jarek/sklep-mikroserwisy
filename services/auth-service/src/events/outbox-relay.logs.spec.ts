import { jest } from '@jest/globals';
import { PinoLogger } from 'nestjs-pino';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { REDACTED_PATHS } from '../common/logger';
import { SERVICE_NAME } from '../config/app-config';
import type { PrismaService } from '../prisma/prisma.service';
import type { AmqpPublisher } from './amqp-publisher.service';
import { userRegisteredEvent } from './event-envelope';
import { OutboxRelay } from './outbox-relay.service';

const EMAIL = 'anna.secret-mail@example.com';
const FIRST_NAME = 'Zdzislawa';

/** A real pino logger (options of createLogger) writing JSON lines to memory. */
function memoryLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      done();
    },
  });
  const logger = pino(
    {
      level: 'info',
      base: { service: SERVICE_NAME },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    },
    stream,
  );
  return { logger: new PinoLogger({ pinoHttp: { logger } }), lines };
}

// nestjs-pino keeps one root logger per process (module), so all tests share it.
const { logger, lines } = memoryLogger();

describe('OutboxRelay logs (real pino)', () => {
  beforeEach(() => {
    lines.length = 0;
  });

  it('carry the ids of the event, never the envelope, the payload, the email or the first name', async () => {
    const ok = userRegisteredEvent({ userId: 'user-ok', email: EMAIL, firstName: FIRST_NAME }, 'req-ok');
    const failed = userRegisteredEvent({ userId: 'user-failed', email: EMAIL, firstName: FIRST_NAME }, 'req-failed');
    const queryRaw = jest
      .fn<() => Promise<unknown[]>>()
      .mockResolvedValueOnce([
        { id: ok.eventId, routing_key: ok.type, envelope: ok, attempts: 1 },
        { id: failed.eventId, routing_key: failed.type, envelope: failed, attempts: 2 },
      ])
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    const publish = jest
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('No confirmation from RabbitMQ within 5000 ms'));
    const relay = new OutboxRelay(
      { $queryRaw: queryRaw, $executeRaw: jest.fn(() => Promise.resolve(1)) } as unknown as PrismaService,
      { canPublish: () => true, awaitsAnswer: () => false, publish } as unknown as AmqpPublisher,
      logger,
    );

    await relay.cycle();
    await relay.cycle();

    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.map((entry) => [entry.level, entry.msg])).toEqual([
      ['info', 'Event published'],
      ['warn', 'Event not published, will retry'],
      ['warn', 'Outbox relay cycle failed'],
    ]);
    expect(entries[0]).toMatchObject({ service: 'auth-service', eventId: ok.eventId, eventType: 'user.registered', requestId: 'req-ok', userId: 'user-ok' });
    expect(entries[1]).toMatchObject({ eventId: failed.eventId, attempts: 2, reason: 'No confirmation from RabbitMQ within 5000 ms', requestId: 'req-failed', userId: 'user-failed' });
    const output = lines.join('\n');
    expect(output).not.toContain(EMAIL);
    expect(output).not.toContain('example.com');
    expect(output).not.toContain(FIRST_NAME);
    expect(output).not.toContain('payload');
    expect(output).not.toContain('occurredAt');
  });

  it('wake() inside a request: the relay logs carry the ids of the event, not of the request (Z10)', async () => {
    const event = userRegisteredEvent({ userId: 'user-event', email: EMAIL, firstName: FIRST_NAME }, 'req-event');
    const relay = new OutboxRelay(
      {
        $queryRaw: jest.fn(() => Promise.resolve([{ id: event.eventId, routing_key: event.type, envelope: event, attempts: 1 }])),
        $executeRaw: jest.fn(() => Promise.resolve(1)),
      } as unknown as PrismaService,
      { canPublish: () => true, awaitsAnswer: () => false, publish: () => Promise.resolve() } as unknown as AmqpPublisher,
      logger,
    );

    // The same context as a registration request: requestId from pino-http, userId from assign().
    await logger.runInContext(
      async () => {
        logger.assign({ userId: 'user-http' });
        logger.info('request log');
        relay.wake();
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      { bindings: { requestId: 'req-http' } },
    );

    const requestLine = lines.find((line) => line.includes('"request log"'));
    expect(JSON.parse(requestLine ?? '{}')).toMatchObject({ requestId: 'req-http', userId: 'user-http' });
    const published = lines.find((line) => line.includes('"Event published"'));
    expect(published).toBeDefined();
    expect(JSON.parse(published ?? '{}')).toMatchObject({ eventId: event.eventId, requestId: 'req-event', userId: 'user-event' });
    // Inherited bindings would appear next to the event ids (pino keeps both keys in the line).
    expect(published).not.toContain('req-http');
    expect(published).not.toContain('user-http');
  });
});
