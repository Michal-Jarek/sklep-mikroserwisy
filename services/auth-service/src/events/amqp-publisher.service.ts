import { Inject, Injectable } from '@nestjs/common';
// Default import (the CommonJS exports object): one place that tests can replace with jest.spyOn.
import amqplib, { type ChannelModel, type ConfirmChannel, type Options, type RecoveringChannelModel } from 'amqplib';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { describeError } from '../consul/consul-http';
import { EVENTS_EXCHANGE } from './event-envelope';

// No broker confirmation within this time = not published (the message may still arrive: duplicates are possible).
// The limit covers opening the channel too.
export const CONFIRM_TIMEOUT_MS = 5000;
// After a publication without an answer the broker counts as not responding (e.g. frozen): nothing is
// published until it answers anything, or for this long; then one event probes it (Z19).
export const NO_ANSWER_PAUSE_MS = 30_000;
// amqplib waits for the broker's close-ok without a limit (checked: forever with a frozen broker).
export const CLOSE_TIMEOUT_MS = 2000;
// Limit for opening a connection (TCP and AMQP handshake): an attempt to a frozen broker fails instead
// of holding a socket. amqplib removes the limit once the connection is open (lib/connect.js, 2.2.1).
export const CONNECT_TIMEOUT_MS = 5000;
// Reconnect delays of amqplib recovery: 1 s, 2 s, 4 s ... at most 30 s (with 20% jitter).
export const RECONNECT_INITIAL_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

interface OpenChannel {
  channel: ConfirmChannel;
  // Reason sent by the server when it closed the channel (e.g. 403 for a routing key without permission).
  closedBy?: Error;
}

// Internal of amqplib 2.2.x (lib/connection.js, checked on 2.2.1): the socket of the connection.
interface ConnectionWithSocket {
  stream?: { destroy(error?: Error): void };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Publisher of events to the shop.events exchange with broker confirmations (amqplib).
 * Never waits for the broker at startup and reconnects on its own (amqplib recovery); without
 * a connection publish() fails at once and the events wait in the outbox. Never declares
 * exchanges or queues (the auth-service account has no configure permission).
 */
@Injectable()
export class AmqpPublisher {
  private connection?: RecoveringChannelModel;
  // Set by the "connect" event. Channels are opened only from it: createConfirmChannel() of the
  // recovering connection waits without a limit while the broker is down (checked).
  private model: ChannelModel | null = null;
  private channel: Promise<OpenChannel> | null = null;
  // True from the first failed attempt or a lost connection until the next connection (one warning per outage).
  private lost = false;
  // The broker sent connection.blocked (memory or disk alarm): it accepts publications but does not route them.
  private blocked = false;
  // When a publication got no answer in time; null once the broker answers anything again.
  private noAnswerSince: number | null = null;
  private onReady: () => void = () => undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(AmqpPublisher.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Starts connecting in the background and returns at once. `onReady` runs whenever publishing becomes
   * possible again: after every (re)connection, when the broker unblocks and when it answers again.
   */
  async start(onReady: () => void): Promise<void> {
    this.onReady = onReady;
    const { host, port, user, password } = this.config.rabbitmq;
    this.connection = await amqplib.connect(
      { protocol: 'amqp', hostname: host, port, username: user, password, vhost: '/' },
      {
        clientProperties: { connection_name: this.config.instanceId },
        timeout: CONNECT_TIMEOUT_MS,
        recovery: {
          initialDelay: RECONNECT_INITIAL_DELAY_MS,
          maxDelay: RECONNECT_MAX_DELAY_MS,
          waitForConnect: false,
        },
      },
    );
    // With waitForConnect: false the first attempt starts after this method returns, so no event is missed.
    this.connection.on('connect', (model: ChannelModel) => this.handleConnected(model));
    this.connection.on('disconnect', (error: Error) => this.handleLost(error));
    this.connection.on('connect-failed', (error: Error) => this.handleLost(error));
    // Forwarded by recovery from the current connection (lib/recovery.js, 2.2.1).
    this.connection.on('blocked', (reason: string) => this.handleBlocked(reason));
    this.connection.on('unblocked', () => this.handleUnblocked());
    // A connection error is followed by "disconnect"; without a listener EventEmitter would throw.
    this.connection.on('error', () => undefined);
  }

  /**
   * False without a connection, while the broker blocks publishing and for 30 s after a publication
   * without an answer. The relay claims nothing then; the events wait in the outbox.
   */
  canPublish(): boolean {
    if (this.model === null || this.blocked) {
      return false;
    }
    return this.noAnswerSince === null || Date.now() - this.noAnswerSince >= NO_ANSWER_PAUSE_MS;
  }

  /** True while the last publication is still without an answer: the next one is a probe (one event). */
  awaitsAnswer(): boolean {
    return this.noAnswerSince !== null;
  }

  /**
   * Resolves when the broker confirmed the message. Rejects when not connected, on a nack, a closed
   * channel or no confirmation in 5 s (opening the channel included). After the limit the message is
   * never published: a channel that opens late is not used for it.
   */
  async publish(routingKey: string, content: Buffer, options: Options.Publish): Promise<void> {
    const opening = this.confirmChannel();
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        this.noAnswerSince = Date.now();
        reject(new Error(`No confirmation from RabbitMQ within ${CONFIRM_TIMEOUT_MS} ms`));
      }, CONFIRM_TIMEOUT_MS);
    });
    const confirmed = opening.then((open) => (expired ? undefined : this.publishOn(open, routingKey, content, options)));
    // Any outcome, also after the limit (a late confirmation, a late channel), means the broker answers.
    const answered = (): void => this.handleAnswer();
    confirmed.then(answered, answered);
    try {
      await Promise.race([confirmed, limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stops reconnecting and closes the connection, waiting at most 2 s for the broker. Leaves no open
   * handle: in the container node is PID 1 and ends after SIGTERM only when the event loop is empty.
   */
  async close(): Promise<void> {
    if (!this.connection) {
      return;
    }
    const model = this.model;
    this.model = null;
    this.channel = null;
    let timer: NodeJS.Timeout | undefined;
    const closed = await Promise.race([
      this.connection.close().then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!closed && model) {
      // The broker did not answer (e.g. frozen): the socket and the heartbeat timers of amqplib would
      // stay. Destroying the socket with an error makes amqplib close the connection and clear its
      // timers; recovery is already stopped, so there is no reconnection.
      (model.connection as unknown as ConnectionWithSocket).stream?.destroy(
        new Error(`RabbitMQ did not confirm the close within ${CLOSE_TIMEOUT_MS} ms`),
      );
    }
  }

  private publishOn(open: OpenChannel, routingKey: string, content: Buffer, options: Options.Publish): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        open.channel.publish(EVENTS_EXCHANGE, routingKey, content, options, (error: unknown) => {
          if (error) {
            reject(open.closedBy ?? toError(error));
          } else {
            resolve();
          }
        });
      } catch (error) {
        // The channel was closed in the meantime (IllegalOperationError).
        reject(open.closedBy ?? toError(error));
      }
    });
  }

  private handleConnected(model: ChannelModel): void {
    this.model = model;
    this.channel = this.openChannel(model);
    this.lost = false;
    this.blocked = false;
    this.noAnswerSince = null;
    this.logger.info('Connected to RabbitMQ');
    this.onReady();
  }

  private handleLost(error: Error): void {
    this.model = null;
    this.channel = null;
    // The next connection starts with a clean state ("connect" wakes the relay).
    this.noAnswerSince = null;
    if (!this.lost) {
      this.lost = true;
      this.logger.warn({ reason: describeError(error) }, 'RabbitMQ connection lost, events wait in the outbox');
    }
  }

  /** One warning per transition to the blocked state; the outbox keeps the events meanwhile. */
  private handleBlocked(reason: string): void {
    if (this.blocked) {
      return;
    }
    this.blocked = true;
    this.logger.warn({ reason }, 'RabbitMQ blocked publishing, events wait in the outbox');
  }

  private handleUnblocked(): void {
    if (!this.blocked) {
      return;
    }
    this.blocked = false;
    this.onReady();
  }

  private handleAnswer(): void {
    if (this.noAnswerSince === null) {
      return;
    }
    this.noAnswerSince = null;
    this.onReady();
  }

  private confirmChannel(): Promise<OpenChannel> {
    if (!this.model) {
      return Promise.reject(new Error('Not connected to RabbitMQ'));
    }
    this.channel ??= this.openChannel(this.model);
    return this.channel;
  }

  /** Confirm channel; when the server closes it, the next publish opens a new one on the same connection. */
  private openChannel(model: ChannelModel): Promise<OpenChannel> {
    const opening: Promise<OpenChannel> = model.createConfirmChannel().then((channel) => {
      const open: OpenChannel = { channel };
      channel.on('error', (error: Error) => {
        open.closedBy = error;
      });
      channel.on('close', () => {
        if (this.channel === opening) {
          this.channel = null;
        }
      });
      return open;
    });
    // A failed open is reported by the publish that awaits it; the next publish tries again.
    opening.catch(() => {
      if (this.channel === opening) {
        this.channel = null;
      }
    });
    return opening;
  }
}
