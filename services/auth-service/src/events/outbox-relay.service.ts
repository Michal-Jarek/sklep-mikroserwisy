import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { describeError } from '../consul/consul-http';
import { PrismaService } from '../prisma/prisma.service';
import { AmqpPublisher } from './amqp-publisher.service';
import { type EventEnvelope, publishOptions } from './event-envelope';

// Decision 13 of stage 4.
export const POLL_INTERVAL_MS = 5000;
export const BATCH_SIZE = 20;
// A claimed event is not taken by another instance for this long (an instance that died gives it back).
export const LEASE_SECONDS = 30;
// A batch never outlives its lease: a row is started only while the lease still covers one publication
// (at most 5 s) and the database update. The rest is given back to the next cycle.
export const BATCH_TIME_LIMIT_MS = (LEASE_SECONDS - 10) * 1000;
export const MAX_RETRY_DELAY_SECONDS = 30;
// Shutdown waits at most this long for the running cycle.
export const SHUTDOWN_WAIT_MS = 5000;
export const LAST_ERROR_MAX_LENGTH = 500;

/** Delay after a failed attempt: 1 s, 2 s, 4 s ... at most 30 s. `attempts` counts this attempt (>= 1). */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(2 ** (attempts - 1), MAX_RETRY_DELAY_SECONDS);
}

interface ClaimedEvent {
  id: string;
  routing_key: string;
  envelope: EventEnvelope;
  attempts: number;
}

function userIdOf(envelope: EventEnvelope): string | undefined {
  const userId = envelope.payload.userId;
  return typeof userId === 'string' ? userId : undefined;
}

/**
 * Publishes events from the outbox_events table (transactional outbox, decision 11): every 5 s,
 * right after a registration, when RabbitMQ becomes usable again and right after a full batch. Each
 * cycle claims up to 20 due events (oldest first) with FOR UPDATE SKIP LOCKED and a 30 s lease and
 * publishes them one by one within 20 s, so a row is handled by one instance at a time. The first
 * failed publication ends the batch (the broker does not answer: the next rows would only wait) and
 * the rows not tried are given back. At-least-once: a lost confirmation can give a duplicate
 * (consumers are idempotent by eventId). Logs never contain the envelope, the payload or the email.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | null = null;
  private runAgain = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: AmqpPublisher,
    @InjectPinoLogger(OutboxRelay.name) private readonly logger: PinoLogger,
  ) {}

  /** Does not wait for RabbitMQ: Auth starts and registers users without it (decision 15). */
  async onApplicationBootstrap(): Promise<void> {
    await this.publisher.start(() => this.wake());
    this.timer = setInterval(() => this.wake(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  /** Starts a cycle now; during a cycle one more cycle runs right after it. Never throws, never waits. */
  wake(): void {
    if (this.stopped) {
      return;
    }
    if (this.running) {
      this.runAgain = true;
      return;
    }
    // A fresh logging context: wake() is called inside a registration request, and the relay logs
    // must not inherit its requestId and userId (they carry the ids of each event instead).
    this.running = this.logger.runInContext(() => this.run());
  }

  private async run(): Promise<void> {
    try {
      let more: boolean;
      do {
        this.runAgain = false;
        more = await this.cycle();
      } while ((more || this.runAgain) && !this.stopped);
    } finally {
      this.running = null;
    }
  }

  /**
   * One pass. Claims nothing when RabbitMQ cannot take events (no connection, blocked, no answer).
   * Returns true when more events are probably due (a full batch, or one cut by the time limit), so
   * the next cycle starts at once. Never throws.
   */
  async cycle(): Promise<boolean> {
    if (!this.publisher.canPublish()) {
      return false;
    }
    try {
      // After 30 s without an answer from the broker a single event probes it (Z19).
      const limit = this.publisher.awaitsAnswer() ? 1 : BATCH_SIZE;
      const deadline = Date.now() + BATCH_TIME_LIMIT_MS;
      const events = await this.claim(limit);
      for (const [index, event] of events.entries()) {
        if (this.stopped) {
          // The rest keeps its lease and is published after 30 s (by this or another instance).
          return false;
        }
        if (Date.now() >= deadline) {
          await this.giveBack(events.slice(index));
          return true;
        }
        if (!(await this.relay(event))) {
          await this.giveBack(events.slice(index + 1));
          return false;
        }
      }
      return events.length === limit;
    } catch (error) {
      this.logger.warn({ reason: describeError(error) }, 'Outbox relay cycle failed');
      return false;
    }
  }

  /** RETURNING keeps no order, so the claimed rows are sorted by created_at in the outer query. */
  private claim(limit: number): Promise<ClaimedEvent[]> {
    return this.prisma.$queryRaw<ClaimedEvent[]>`
      WITH claimed AS (
        UPDATE outbox_events SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
        WHERE id IN (SELECT id FROM outbox_events
                     WHERE published_at IS NULL AND next_attempt_at <= now()
                     ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        RETURNING id, routing_key, envelope, attempts, created_at)
      SELECT id, routing_key, envelope, attempts FROM claimed ORDER BY created_at`;
  }

  /** Rows of a batch that ended early were not tried: they are due again at once, as before the claim. */
  private async giveBack(events: ClaimedEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const ids = events.map((event) => event.id);
    await this.prisma.$executeRaw`
      UPDATE outbox_events SET attempts = attempts - 1, next_attempt_at = now()
      WHERE id = ANY(${ids}::uuid[]) AND published_at IS NULL`;
  }

  /** Publishes one event and records the result; false when it was not published. */
  private async relay(event: ClaimedEvent): Promise<boolean> {
    const { envelope } = event;
    const eventId = envelope.eventId;
    const eventType = envelope.type;
    const requestId = envelope.requestId;
    const userId = userIdOf(envelope);
    try {
      await this.publisher.publish(event.routing_key, Buffer.from(JSON.stringify(envelope)), publishOptions(envelope));
    } catch (error) {
      // Error messages of amqplib name the exchange and the routing key, never the message body.
      const reason = describeError(error).slice(0, LAST_ERROR_MAX_LENGTH);
      await this.prisma.$executeRaw`
        UPDATE outbox_events
        SET next_attempt_at = now() + make_interval(secs => ${retryDelaySeconds(event.attempts)}), last_error = ${reason}
        WHERE id = ${event.id}::uuid AND published_at IS NULL`;
      this.logger.warn(
        { eventId, eventType, attempts: event.attempts, reason, requestId, userId },
        'Event not published, will retry',
      );
      return false;
    }
    // Both results only for a row not published yet: a slower instance never overwrites them.
    await this.prisma.$executeRaw`
      UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id = ${event.id}::uuid AND published_at IS NULL`;
    this.logger.info({ eventId, eventType, requestId, userId }, 'Event published');
    return true;
  }

  /** Stops the cycles, waits for the running one (at most 5 s) and closes the RabbitMQ connection. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.running) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.running,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    await this.publisher.close();
  }
}
