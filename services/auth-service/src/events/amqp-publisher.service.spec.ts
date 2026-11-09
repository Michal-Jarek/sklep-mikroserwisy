import { jest } from '@jest/globals';
import amqplib, { type ChannelModel } from 'amqplib';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { PinoLogger } from 'nestjs-pino';
import { buildConfig, KV_DEFAULTS } from '../config/app-config';
import { AmqpPublisher, CLOSE_TIMEOUT_MS, CONFIRM_TIMEOUT_MS, NO_ANSWER_PAUSE_MS } from './amqp-publisher.service';

/** Fake confirm channel: publish() keeps the confirmation callback, the test decides the answer. */
class FakeChannel extends EventEmitter {
  closed = false;
  readonly published: { exchange: string; routingKey: string; content: Buffer; options: unknown }[] = [];
  readonly confirmations: ((error: unknown) => void)[] = [];

  publish(exchange: string, routingKey: string, content: Buffer, options: unknown, confirm: (error: unknown) => void): boolean {
    if (this.closed) {
      throw new Error('Channel closed');
    }
    this.published.push({ exchange, routingKey, content, options });
    this.confirmations.push(confirm);
    return true;
  }

  /** The server closes the channel (e.g. 403): "error", "close", then pending confirmations fail. */
  closeByServer(reason: string): void {
    this.closed = true;
    this.emit('error', new Error(reason));
    this.emit('close');
    this.confirmations.splice(0).forEach((confirm) => confirm(new Error('channel closed')));
  }
}

class FakeModel extends EventEmitter {
  readonly channels: FakeChannel[] = [];
  // The socket of the amqplib connection (internal field "stream").
  readonly connection = { stream: { destroy: jest.fn<(error?: Error) => void>() } };

  createConfirmChannel(): Promise<FakeChannel> {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return Promise.resolve(channel);
  }
}

/** A broker that does not answer channel.open (e.g. frozen): the test opens the channel later. */
class SlowChannelModel extends FakeModel {
  openChannel: () => void = () => undefined;

  override createConfirmChannel(): Promise<FakeChannel> {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return new Promise((resolve) => {
      this.openChannel = () => resolve(channel);
    });
  }
}

class FakeRecoveringConnection extends EventEmitter {
  close = jest.fn<() => Promise<void>>(() => Promise.resolve());
}

const connection = new FakeRecoveringConnection();

// No real broker in unit tests. amqplib.connect is overloaded, so the fake is cast to its type.
function mockConnect() {
  return jest.spyOn(amqplib, 'connect').mockImplementation((() => Promise.resolve(connection)) as unknown as typeof amqplib.connect);
}

const ENV = {
  DB_HOST: 'postgres',
  DB_NAME: 'auth_db',
  DB_USER: 'auth_service',
  DB_PASSWORD: 'test-password',
  RABBITMQ_HOST: 'rabbitmq',
  RABBITMQ_PORT: '5672',
  RABBITMQ_USER: 'auth-service',
  RABBITMQ_PASSWORD: 'test-rabbitmq-password',
};
const OPTIONS = { persistent: true, contentType: 'application/json', messageId: 'e-1' };
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('AmqpPublisher', () => {
  const logger = { info: jest.fn(), warn: jest.fn() };
  const onReady = jest.fn();
  const config = buildConfig(ENV, KV_DEFAULTS);

  async function started() {
    const publisher = new AmqpPublisher(config, logger as unknown as PinoLogger);
    await publisher.start(onReady);
    return publisher;
  }

  async function connected() {
    const publisher = await started();
    const model = new FakeModel();
    connection.emit('connect', model);
    await flush();
    return { publisher, model };
  }

  let connect: ReturnType<typeof mockConnect>;

  beforeEach(() => {
    jest.clearAllMocks();
    connection.removeAllListeners();
    connection.close.mockResolvedValue(undefined);
    connect = mockConnect();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('connects with the instance id as connection name, a 5 s limit for opening and recovery that does not wait for the broker', async () => {
    await started();

    expect(connect).toHaveBeenCalledWith(
      { protocol: 'amqp', hostname: 'rabbitmq', port: 5672, username: 'auth-service', password: 'test-rabbitmq-password', vhost: '/' },
      {
        clientProperties: { connection_name: config.instanceId },
        // Only for opening the connection (amqplib removes it afterwards).
        timeout: 5000,
        recovery: { initialDelay: 1000, maxDelay: 30000, waitForConnect: false },
      },
    );
    expect(connection.listenerCount('error')).toBe(1);
  });

  it('logs one warning per outage and "Connected to RabbitMQ" on every connection (Z6)', async () => {
    const publisher = await started();
    const warnings = () => logger.warn.mock.calls.filter((call) => call[1] === 'RabbitMQ connection lost, events wait in the outbox');

    // Start without a broker: the first failed attempt.
    connection.emit('connect-failed', new Error('connect ECONNREFUSED 10.0.0.5:5672'));
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0][0]).toEqual({ reason: 'connect ECONNREFUSED 10.0.0.5:5672' });

    // Three more failed attempts in the same outage: still one warning.
    for (let i = 0; i < 3; i += 1) {
      connection.emit('connect-failed', new Error('getaddrinfo ENOTFOUND rabbitmq'));
    }
    expect(warnings()).toHaveLength(1);
    expect(publisher.canPublish()).toBe(false);

    connection.emit('connect', new FakeModel());
    expect(logger.info).toHaveBeenCalledWith('Connected to RabbitMQ');
    expect(publisher.canPublish()).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);

    connection.emit('disconnect', new Error('Connection closed: 320 (CONNECTION-FORCED)'));
    connection.emit('connect-failed', new Error('connect ECONNREFUSED 10.0.0.5:5672'));
    expect(warnings()).toHaveLength(2);
    expect(publisher.canPublish()).toBe(false);

    connection.emit('connect', new FakeModel());
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenCalledTimes(2);
  });

  it('opens a confirm channel right after every connection', async () => {
    const { model } = await connected();

    expect(model.channels).toHaveLength(1);
  });

  it('fails at once without a connection', async () => {
    const publisher = await started();

    await expect(publisher.publish('user.registered', Buffer.from('{}'), OPTIONS)).rejects.toThrow('Not connected to RabbitMQ');
  });

  it('publishes to shop.events and resolves on the broker confirmation', async () => {
    const { publisher, model } = await connected();

    const result = publisher.publish('user.registered', Buffer.from('{"a":1}'), OPTIONS);
    await flush();
    const [channel] = model.channels;
    expect(channel.published).toEqual([
      { exchange: 'shop.events', routingKey: 'user.registered', content: Buffer.from('{"a":1}'), options: OPTIONS },
    ]);
    channel.confirmations[0](null);

    await expect(result).resolves.toBeUndefined();
  });

  it('rejects on a nack', async () => {
    const { publisher, model } = await connected();

    const result = publisher.publish('user.registered', Buffer.from('{}'), OPTIONS);
    await flush();
    model.channels[0].confirmations[0](new Error('message nacked'));

    await expect(result).rejects.toThrow('message nacked');
  });

  it('a channel closed by the server (403): the reason of the server, then a new channel on the same connection', async () => {
    const { publisher, model } = await connected();
    const refused = 'Channel closed by server: 403 (ACCESS-REFUSED) with message "ACCESS_REFUSED - write access to topic"';

    const first = publisher.publish('order.created', Buffer.from('{}'), OPTIONS);
    await flush();
    model.channels[0].closeByServer(refused);
    await expect(first).rejects.toThrow(refused);

    const second = publisher.publish('user.registered', Buffer.from('{}'), OPTIONS);
    await flush();
    expect(model.channels).toHaveLength(2);
    model.channels[1].confirmations[0](null);
    await expect(second).resolves.toBeUndefined();
  });

  it('rejects after 5 s without a confirmation', async () => {
    const { publisher } = await connected();
    jest.useFakeTimers();

    const result = publisher.publish('user.registered', Buffer.from('{}'), OPTIONS);
    const outcome = result.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS - 1);
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    expect(await outcome).toEqual(new Error('No confirmation from RabbitMQ within 5000 ms'));
  });

  it('after a lost connection the old channel is not used, the next connection opens a new one', async () => {
    const { publisher, model } = await connected();

    connection.emit('disconnect', new Error('Connection closed'));
    await expect(publisher.publish('user.registered', Buffer.from('{}'), OPTIONS)).rejects.toThrow('Not connected to RabbitMQ');
    const next = new FakeModel();
    connection.emit('connect', next);
    const result = publisher.publish('user.registered', Buffer.from('{}'), OPTIONS);
    await flush();
    next.channels[0].confirmations[0](null);

    await expect(result).resolves.toBeUndefined();
    expect(model.channels[0].published).toHaveLength(0);
  });

  it('the 5 s limit covers opening the channel; a channel that opens late is not used for that message (C7)', async () => {
    const publisher = await started();
    const model = new SlowChannelModel();
    connection.emit('connect', model);
    jest.useFakeTimers();

    const outcome = publisher.publish('user.registered', Buffer.from('{}'), OPTIONS).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
    expect(await outcome).toEqual(new Error('No confirmation from RabbitMQ within 5000 ms'));

    model.openChannel();
    await jest.advanceTimersByTimeAsync(0);
    expect(model.channels[0].published).toHaveLength(0);
  });

  describe('blocked by the broker (memory or disk alarm)', () => {
    const blockedWarnings = () => logger.warn.mock.calls.filter((call) => call[1] === 'RabbitMQ blocked publishing, events wait in the outbox');

    it('cannot publish while blocked, one warning per transition, unblocked wakes the relay without a new info', async () => {
      const { publisher } = await connected();
      onReady.mockClear();
      logger.info.mockClear();

      connection.emit('blocked', 'low on memory');
      connection.emit('blocked', 'low on memory');
      expect(publisher.canPublish()).toBe(false);
      expect(blockedWarnings()).toEqual([[{ reason: 'low on memory' }, 'RabbitMQ blocked publishing, events wait in the outbox']]);

      connection.emit('unblocked');
      expect(publisher.canPublish()).toBe(true);
      expect(onReady).toHaveBeenCalledTimes(1);
      connection.emit('unblocked');
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(logger.info).not.toHaveBeenCalled();

      connection.emit('blocked', 'low on disk');
      expect(blockedWarnings()).toHaveLength(2);
      expect(publisher.canPublish()).toBe(false);
    });

    it('a new connection starts unblocked', async () => {
      const { publisher } = await connected();
      connection.emit('blocked', 'low on memory');

      connection.emit('disconnect', new Error('Connection closed'));
      connection.emit('connect', new FakeModel());

      expect(publisher.canPublish()).toBe(true);
    });
  });

  describe('a broker that does not answer (Z19)', () => {
    /** Connected publisher whose first publication got no confirmation within 5 s. */
    async function unanswered() {
      const { publisher, model } = await connected();
      jest.useFakeTimers();
      const outcome = publisher.publish('user.registered', Buffer.from('{}'), OPTIONS).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
      expect(await outcome).toEqual(new Error('No confirmation from RabbitMQ within 5000 ms'));
      onReady.mockClear();
      return { publisher, model };
    }

    it('no confirmation in 5 s: publishing waits for an answer', async () => {
      const { publisher } = await unanswered();

      expect(publisher.canPublish()).toBe(false);
      expect(publisher.awaitsAnswer()).toBe(true);
    });

    it('a late confirmation is an answer: publishing again and the relay is woken', async () => {
      const { publisher, model } = await unanswered();

      model.channels[0].confirmations[0](null);
      await jest.advanceTimersByTimeAsync(0);

      expect(publisher.canPublish()).toBe(true);
      expect(publisher.awaitsAnswer()).toBe(false);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('a late nack or a closed channel is an answer too', async () => {
      const { publisher, model } = await unanswered();

      model.channels[0].closeByServer('Channel closed by server: 406 (PRECONDITION-FAILED)');
      await jest.advanceTimersByTimeAsync(0);

      expect(publisher.canPublish()).toBe(true);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('a channel that opens late is an answer', async () => {
      const publisher = await started();
      const model = new SlowChannelModel();
      connection.emit('connect', model);
      jest.useFakeTimers();
      const outcome = publisher.publish('user.registered', Buffer.from('{}'), OPTIONS).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
      await outcome;
      expect(publisher.canPublish()).toBe(false);
      onReady.mockClear();

      model.openChannel();
      await jest.advanceTimersByTimeAsync(0);

      expect(publisher.canPublish()).toBe(true);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('a lost connection clears the state, the next connection wakes the relay', async () => {
      const { publisher } = await unanswered();

      connection.emit('disconnect', new Error('Heartbeat timeout'));
      expect(publisher.canPublish()).toBe(false);
      expect(publisher.awaitsAnswer()).toBe(false);
      connection.emit('connect', new FakeModel());

      expect(publisher.canPublish()).toBe(true);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('after 30 s without an answer one probe may be published; no confirmation again: another 30 s', async () => {
      const { publisher, model } = await unanswered();

      await jest.advanceTimersByTimeAsync(NO_ANSWER_PAUSE_MS - CONFIRM_TIMEOUT_MS - 1);
      expect(publisher.canPublish()).toBe(false);
      await jest.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 1);
      expect(publisher.canPublish()).toBe(true);
      expect(publisher.awaitsAnswer()).toBe(true);

      const probe = publisher.publish('user.registered', Buffer.from('{}'), OPTIONS).catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
      expect(await probe).toEqual(new Error('No confirmation from RabbitMQ within 5000 ms'));
      expect(model.channels[0].published).toHaveLength(2);
      expect(publisher.canPublish()).toBe(false);
      await jest.advanceTimersByTimeAsync(NO_ANSWER_PAUSE_MS - 1);
      expect(publisher.canPublish()).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(publisher.canPublish()).toBe(true);
      expect(onReady).not.toHaveBeenCalled();
    });

    it('a probe confirmed in time ends the state', async () => {
      const { publisher, model } = await unanswered();
      await jest.advanceTimersByTimeAsync(NO_ANSWER_PAUSE_MS);

      const probe = publisher.publish('user.registered', Buffer.from('{}'), OPTIONS);
      await jest.advanceTimersByTimeAsync(0);
      model.channels[0].confirmations[1](null);

      await expect(probe).resolves.toBeUndefined();
      expect(publisher.awaitsAnswer()).toBe(false);
      expect(publisher.canPublish()).toBe(true);
    });

    it('blocked and not answering together: publishing needs both to end', async () => {
      const { publisher, model } = await unanswered();
      connection.emit('blocked', 'low on memory');

      connection.emit('unblocked');
      expect(publisher.canPublish()).toBe(false);
      connection.emit('blocked', 'low on memory');
      model.channels[0].confirmations[0](null);
      await jest.advanceTimersByTimeAsync(0);
      expect(publisher.canPublish()).toBe(false);

      connection.emit('unblocked');
      expect(publisher.canPublish()).toBe(true);
    });
  });

  it('close() with a frozen broker: returns after 2 s and destroys the socket (no handle keeps node running)', async () => {
    const { publisher, model } = await connected();
    connection.close.mockReturnValue(new Promise(() => undefined));
    jest.useFakeTimers();

    let closed = false;
    void publisher.close().then(() => {
      closed = true;
    });
    await jest.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS - 1);
    expect(closed).toBe(false);
    expect(model.connection.stream.destroy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(closed).toBe(true);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(model.connection.stream.destroy).toHaveBeenCalledTimes(1);
    expect(model.connection.stream.destroy.mock.calls[0][0]).toEqual(
      new Error('RabbitMQ did not confirm the close within 2000 ms'),
    );
    expect(publisher.canPublish()).toBe(false);
  });

  it('close() answered by the broker: the socket is left to amqplib', async () => {
    const { publisher, model } = await connected();

    await publisher.close();

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(model.connection.stream.destroy).not.toHaveBeenCalled();
  });

  it('close() without a connection: nothing to destroy, returns after at most 2 s', async () => {
    const publisher = await started();
    const lost = new FakeModel();
    connection.emit('connect', lost);
    connection.emit('disconnect', new Error('Connection closed'));
    connection.close.mockReturnValue(new Promise(() => undefined));
    jest.useFakeTimers();

    let closed = false;
    void publisher.close().then(() => {
      closed = true;
    });
    await jest.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS);

    expect(closed).toBe(true);
    expect(lost.connection.stream.destroy).not.toHaveBeenCalled();
  });

  it('close() before start(): nothing to close', async () => {
    const publisher = new AmqpPublisher(config, logger as unknown as PinoLogger);

    await expect(publisher.close()).resolves.toBeUndefined();
    expect(connection.close).not.toHaveBeenCalled();
  });
});

/**
 * close() destroys model.connection.stream, an internal field of amqplib (E11, Z17). The version is
 * pinned (2.2.1); this test fails if an update renames the field, instead of E11 coming back silently.
 */
describe('amqplib internals used by close() (installed package, no broker)', () => {
  it('the model of a connection has connection.stream: the socket, with destroy()', () => {
    // amqplib exports only its public API, so its files are loaded by path from the installed package.
    const requireHere = createRequire(join(process.cwd(), 'package.json'));
    const lib = join(dirname(requireHere.resolve('amqplib')), 'lib');
    const { Connection } = requireHere(join(lib, 'connection.js')) as {
      Connection: { new (socket: PassThrough): unknown; prototype: Record<string, unknown> };
    };
    const { ChannelModel: RealChannelModel } = requireHere(join(lib, 'channel_model.js')) as {
      ChannelModel: new (connection: unknown) => ChannelModel;
    };
    const socket = new PassThrough();

    const model = new RealChannelModel(new Connection(socket));

    const { stream } = model.connection as unknown as { stream?: { destroy?: unknown } };
    expect(stream).toBe(socket);
    expect(typeof stream?.destroy).toBe('function');
    // A socket error closes the connection and clears its heartbeat timers.
    expect([typeof Connection.prototype.onSocketError, typeof Connection.prototype.toClosed]).toEqual(['function', 'function']);
  });
});
