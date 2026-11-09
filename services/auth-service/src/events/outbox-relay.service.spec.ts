import { jest } from '@jest/globals';
import type { Options } from 'amqplib';
import type { PinoLogger } from 'nestjs-pino';
import type { PrismaService } from '../prisma/prisma.service';
import type { AmqpPublisher } from './amqp-publisher.service';
import { userRegisteredEvent } from './event-envelope';
import {
  BATCH_SIZE,
  BATCH_TIME_LIMIT_MS,
  LAST_ERROR_MAX_LENGTH,
  LEASE_SECONDS,
  OutboxRelay,
  POLL_INTERVAL_MS,
  retryDelaySeconds,
  SHUTDOWN_WAIT_MS,
} from './outbox-relay.service';

type Row = { id: string; routing_key: string; envelope: ReturnType<typeof userRegisteredEvent>; attempts: number };

interface SqlCall {
  sql: string;
  values: unknown[];
}

function row(attempts = 1, email = 'anna@example.com'): Row {
  const envelope = userRegisteredEvent({ userId: `user-${attempts}`, email, firstName: 'Anna' }, `req-${attempts}`);
  return { id: envelope.eventId, routing_key: envelope.type, envelope, attempts };
}

function rows(count: number): Row[] {
  return Array.from({ length: count }, () => row(1));
}

const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const GIVE_BACK = 'UPDATE outbox_events SET attempts = attempts - 1, next_attempt_at = now() WHERE id = ANY(?::uuid[]) AND published_at IS NULL';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** Prisma with the two raw SQL calls of the relay: $queryRaw claims, $executeRaw records the result. */
function fakePrisma() {
  const claims: SqlCall[] = [];
  const updates: SqlCall[] = [];
  const queryRaw = jest.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>>((strings, ...values) => {
    claims.push({ sql: strings.join('?'), values });
    return Promise.resolve([]);
  });
  const executeRaw = jest.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>>((strings, ...values) => {
    updates.push({ sql: strings.join('?'), values });
    return Promise.resolve(1);
  });
  return { prisma: { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as PrismaService, claims, updates, queryRaw, executeRaw };
}

describe('OutboxRelay', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    runInContext: jest.fn(<T>(fn: () => T): T => fn()),
  };
  const canPublish = jest.fn<() => boolean>();
  const awaitsAnswer = jest.fn<() => boolean>();
  const publish = jest.fn<(routingKey: string, content: Buffer, options: Options.Publish) => Promise<void>>();
  const start = jest.fn<(onConnected: () => void) => Promise<void>>();
  const close = jest.fn<() => Promise<void>>();

  function createRelay() {
    const db = fakePrisma();
    const relay = new OutboxRelay(
      db.prisma,
      { canPublish, awaitsAnswer, publish, start, close } as unknown as AmqpPublisher,
      logger as unknown as PinoLogger,
    );
    return { relay, ...db };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    canPublish.mockReturnValue(true);
    awaitsAnswer.mockReturnValue(false);
    publish.mockResolvedValue(undefined);
    start.mockResolvedValue(undefined);
    close.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('claims due events with FOR UPDATE SKIP LOCKED, a 30 s lease and at most 20 rows, returned oldest first', async () => {
    const { relay, claims } = createRelay();

    await relay.cycle();

    expect(claims).toHaveLength(1);
    expect(oneLine(claims[0].sql)).toBe(
      'WITH claimed AS ( ' +
        'UPDATE outbox_events SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => ?) ' +
        'WHERE id IN (SELECT id FROM outbox_events WHERE published_at IS NULL AND next_attempt_at <= now() ' +
        'ORDER BY created_at LIMIT ? FOR UPDATE SKIP LOCKED) ' +
        'RETURNING id, routing_key, envelope, attempts, created_at) ' +
        'SELECT id, routing_key, envelope, attempts FROM claimed ORDER BY created_at',
    );
    expect(claims[0].values).toEqual([LEASE_SECONDS, BATCH_SIZE]);
    expect([LEASE_SECONDS, BATCH_SIZE, POLL_INTERVAL_MS, BATCH_TIME_LIMIT_MS]).toEqual([30, 20, 5000, 20_000]);
  });

  it('claims a single event (a probe) while the broker has not answered the last publication', async () => {
    const { relay, claims } = createRelay();
    awaitsAnswer.mockReturnValue(true);

    await relay.cycle();

    expect(claims[0].values).toEqual([LEASE_SECONDS, 1]);
  });

  it('claims nothing when RabbitMQ cannot take events (no connection, blocked, no answer)', async () => {
    const { relay, queryRaw } = createRelay();
    canPublish.mockReturnValue(false);

    await relay.cycle();

    expect(queryRaw).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes the envelope as JSON with its AMQP properties, then sets published_at and logs the ids', async () => {
    const { relay, queryRaw, updates } = createRelay();
    const event = row(1);
    queryRaw.mockResolvedValueOnce([event]);

    await relay.cycle();

    expect(publish).toHaveBeenCalledTimes(1);
    const [routingKey, content, options] = publish.mock.calls[0];
    expect(routingKey).toBe('user.registered');
    expect(JSON.parse(content.toString('utf8'))).toEqual(event.envelope);
    expect(options).toMatchObject({ persistent: true, messageId: event.id, type: 'user.registered', appId: 'auth-service' });
    expect(updates).toHaveLength(1);
    expect(oneLine(updates[0].sql)).toBe(
      'UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id = ?::uuid AND published_at IS NULL',
    );
    expect(updates[0].values).toEqual([event.id]);
    expect(logger.info).toHaveBeenCalledWith(
      { eventId: event.id, eventType: 'user.registered', requestId: 'req-1', userId: 'user-1' },
      'Event published',
    );
  });

  it.each([
    ['a nack or a closed channel', new Error('Channel closed by server: 403 (ACCESS-REFUSED)')],
    ['no confirmation in 5 s', new Error('No confirmation from RabbitMQ within 5000 ms')],
    ['a lost connection', new Error('Not connected to RabbitMQ')],
  ])('after %s: next attempt after the backoff delay, last_error and a warning', async (_case, error) => {
    const { relay, queryRaw, updates } = createRelay();
    const event = row(3);
    queryRaw.mockResolvedValueOnce([event]);
    publish.mockRejectedValueOnce(error);

    await relay.cycle();

    expect(updates).toHaveLength(1);
    expect(oneLine(updates[0].sql)).toBe(
      'UPDATE outbox_events SET next_attempt_at = now() + make_interval(secs => ?), last_error = ? WHERE id = ?::uuid AND published_at IS NULL',
    );
    expect(updates[0].values).toEqual([4, error.message, event.id]);
    expect(logger.warn).toHaveBeenCalledWith(
      { eventId: event.id, eventType: 'user.registered', attempts: 3, reason: error.message, requestId: 'req-3', userId: 'user-3' },
      'Event not published, will retry',
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('the first failed event ends the batch: the rows not tried are given back (attempts - 1, due now)', async () => {
    const { relay, queryRaw, updates } = createRelay();
    const batch = rows(4);
    queryRaw.mockResolvedValueOnce(batch);
    publish.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('No confirmation from RabbitMQ within 5000 ms'));

    await expect(relay.cycle()).resolves.toBe(false);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(3);
    expect(updates[0].sql).toContain('published_at = now()');
    expect(updates[1].sql).toContain('last_error = ');
    expect(oneLine(updates[2].sql)).toBe(GIVE_BACK);
    expect(updates[2].values).toEqual([[batch[2].id, batch[3].id]]);
  });

  it('a failed last event gives nothing back', async () => {
    const { relay, queryRaw, updates } = createRelay();
    queryRaw.mockResolvedValueOnce([row(1)]);
    publish.mockRejectedValueOnce(new Error('Not connected to RabbitMQ'));

    await relay.cycle();

    expect(updates).toHaveLength(1);
  });

  it('a batch never outlives its lease: no event is started after 20 s, the rest is given back (C5)', async () => {
    jest.useFakeTimers();
    const { relay, queryRaw, updates } = createRelay();
    const batch = rows(BATCH_SIZE);
    queryRaw.mockResolvedValueOnce(batch);
    // A slow broker: every confirmation takes 4 s.
    publish.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 4000)));

    const result = relay.cycle();
    await jest.advanceTimersByTimeAsync(BATCH_TIME_LIMIT_MS);

    // Started at 0, 4, 8, 12 and 16 s; the sixth would start at 20 s.
    await expect(result).resolves.toBe(true);
    expect(publish).toHaveBeenCalledTimes(5);
    const giveBack = updates.filter((update) => oneLine(update.sql) === GIVE_BACK);
    expect(giveBack).toHaveLength(1);
    expect(giveBack[0].values).toEqual([batch.slice(5).map((event) => event.id)]);
    expect(LEASE_SECONDS * 1000 - BATCH_TIME_LIMIT_MS).toBeGreaterThanOrEqual(2 * 5000);
  });

  it('a full batch: the next cycle starts at once, without waiting 5 s (C8)', async () => {
    const { relay, queryRaw } = createRelay();
    queryRaw.mockResolvedValueOnce(rows(BATCH_SIZE)).mockResolvedValueOnce(rows(3));

    relay.wake();
    await flush();

    // 20 (full) -> at once 3 (not full) -> stop.
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(BATCH_SIZE + 3);
  });

  it('a batch that is not full ends the cycles until the next wake', async () => {
    const { relay, queryRaw } = createRelay();
    queryRaw.mockResolvedValueOnce(rows(BATCH_SIZE - 1));

    relay.wake();
    await flush();

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('cuts last_error to 500 characters', async () => {
    const { relay, queryRaw, updates } = createRelay();
    queryRaw.mockResolvedValueOnce([row(1)]);
    publish.mockRejectedValueOnce(new Error('x'.repeat(2000)));

    await relay.cycle();

    expect(updates[0].values[1]).toHaveLength(LAST_ERROR_MAX_LENGTH);
  });

  it('retry delay: 1, 2, 4, 8, 16 s, then 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelaySeconds)).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
  });

  it('a database error in a cycle is logged and does not throw', async () => {
    const { relay, queryRaw } = createRelay();
    queryRaw.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

    await expect(relay.cycle()).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledWith({ reason: 'Connection terminated unexpectedly' }, 'Outbox relay cycle failed');
  });

  it('wake() during a cycle runs exactly one more cycle after it', async () => {
    const { relay, queryRaw } = createRelay();
    const first = deferred<Row[]>();
    queryRaw.mockReturnValueOnce(first.promise);

    relay.wake();
    relay.wake();
    relay.wake();
    await flush();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    first.resolve([]);
    await flush();

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(logger.runInContext).toHaveBeenCalledTimes(1);
    relay.wake();
    await flush();
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  it('starts the publisher (its connection wakes the relay) and runs a cycle every 5 s', async () => {
    jest.useFakeTimers();
    const { relay, queryRaw } = createRelay();

    await relay.onApplicationBootstrap();
    expect(queryRaw).not.toHaveBeenCalled();
    start.mock.calls[0][0]();
    await jest.advanceTimersByTimeAsync(0);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(queryRaw).toHaveBeenCalledTimes(2);

    await relay.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(3 * POLL_INTERVAL_MS);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('shutdown waits for the running cycle, publishes nothing more, then closes the connection', async () => {
    const { relay, queryRaw, updates } = createRelay();
    const confirm = deferred<undefined>();
    queryRaw.mockResolvedValueOnce([row(1), row(2)]);
    publish.mockReturnValueOnce(confirm.promise);
    relay.wake();
    await flush();

    let stopped = false;
    const stopping = relay.onModuleDestroy().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(close).not.toHaveBeenCalled();
    confirm.resolve(undefined);
    await stopping;

    expect(updates).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    relay.wake();
    await flush();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('shutdown waits at most 5 s for a hanging cycle', async () => {
    jest.useFakeTimers();
    const { relay, queryRaw } = createRelay();
    queryRaw.mockReturnValueOnce(new Promise(() => undefined));
    relay.wake();

    let stopped = false;
    void relay.onModuleDestroy().then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(SHUTDOWN_WAIT_MS - 1);
    expect(stopped).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    expect(stopped).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
