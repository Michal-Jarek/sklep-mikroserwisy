import { Module } from '@nestjs/common';
import { AmqpPublisher } from './amqp-publisher.service';
import { OutboxRelay } from './outbox-relay.service';

/** Event publishing through the outbox (stage 4). AuthService writes events and calls OutboxRelay.wake(). */
@Module({
  providers: [AmqpPublisher, OutboxRelay],
  exports: [OutboxRelay],
})
export class EventsModule {}
