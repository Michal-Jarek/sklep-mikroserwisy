import { EVENTS_EXCHANGE, publishOptions, USER_REGISTERED, userRegisteredEvent } from './event-envelope';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USER = { userId: '0b6f3c1e-8f4a-4d2b-9c3e-1a2b3c4d5e6f', email: 'anna.nowak@example.com', firstName: 'Anna' };

describe('user.registered envelope (contract 3.5)', () => {
  it('has exactly the envelope fields and exactly three payload fields', () => {
    const now = new Date('2026-11-09T07:12:45.123Z');

    const envelope = userRegisteredEvent(USER, 'req-1', now);

    expect(Object.keys(envelope)).toEqual(['eventId', 'type', 'version', 'occurredAt', 'requestId', 'payload']);
    expect(envelope).toEqual({
      eventId: expect.stringMatching(UUID_V4),
      type: 'user.registered',
      version: 1,
      occurredAt: '2026-11-09T07:12:45.123Z',
      requestId: 'req-1',
      payload: USER,
    });
    expect(Object.keys(envelope.payload)).toEqual(['userId', 'email', 'firstName']);
  });

  it('copies only the three payload fields, even when the caller passes more', () => {
    const withExtra = { ...USER, lastName: 'Nowak', password: 'secret-123456' };

    const envelope = userRegisteredEvent(withExtra, 'req-1');

    expect(envelope.payload).toEqual(USER);
  });

  it('gives every event a new id and an ISO 8601 UTC time with milliseconds', () => {
    const first = userRegisteredEvent(USER, 'req-1');
    const second = userRegisteredEvent(USER, 'req-1');

    expect(first.eventId).not.toBe(second.eventId);
    expect(first.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('serializes to UTF-8 JSON that parses back to the same envelope', () => {
    const envelope = userRegisteredEvent({ ...USER, firstName: 'Zoë' }, 'req-1');

    const body = Buffer.from(JSON.stringify(envelope));

    expect(JSON.parse(body.toString('utf8'))).toEqual(envelope);
  });
});

describe('AMQP properties of an event', () => {
  it('are persistent JSON with message id, type, timestamp in seconds and app id', () => {
    const envelope = userRegisteredEvent(USER, 'req-1', new Date('2026-11-09T07:12:45.999Z'));

    expect(publishOptions(envelope)).toEqual({
      persistent: true,
      contentType: 'application/json',
      messageId: envelope.eventId,
      type: USER_REGISTERED,
      timestamp: Date.UTC(2026, 10, 9, 7, 12, 45) / 1000,
      appId: 'auth-service',
    });
  });

  it('go to the shop.events exchange', () => {
    expect(EVENTS_EXCHANGE).toBe('shop.events');
  });
});
