import type { Options } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { SERVICE_NAME } from '../config/app-config';

// Contract 3.5 of stage 4 (docs/events.md): one topic exchange, routing key = event type.
export const EVENTS_EXCHANGE = 'shop.events';
export const USER_REGISTERED = 'user.registered';
export const USER_REGISTERED_VERSION = 1;

/** Envelope v1 of every event: exactly these top-level fields. */
export type EventEnvelope<P extends object = Record<string, unknown>> = {
  // UUID v4 in lower case, also the id of the outbox row and the AMQP message_id.
  eventId: string;
  type: string;
  version: number;
  // ISO 8601 UTC with milliseconds and "Z".
  occurredAt: string;
  // X-Request-Id of the request that caused the event.
  requestId: string;
  payload: P;
};

// Exactly these three fields: no last name, no password. The email is personal data, never log it.
export type UserRegisteredPayload = { userId: string; email: string; firstName: string };

export function userRegisteredEvent(
  user: UserRegisteredPayload,
  requestId: string,
  now: Date = new Date(),
): EventEnvelope<UserRegisteredPayload> {
  return {
    eventId: randomUUID(),
    type: USER_REGISTERED,
    version: USER_REGISTERED_VERSION,
    occurredAt: now.toISOString(),
    requestId,
    payload: { userId: user.userId, email: user.email, firstName: user.firstName },
  };
}

/** AMQP properties of an event message (contract 3.5): persistent, JSON, ids from the envelope. */
export function publishOptions(envelope: EventEnvelope): Options.Publish {
  return {
    persistent: true,
    contentType: 'application/json',
    messageId: envelope.eventId,
    type: envelope.type,
    // AMQP timestamp in seconds.
    timestamp: Math.floor(Date.parse(envelope.occurredAt) / 1000),
    appId: SERVICE_NAME,
  };
}
