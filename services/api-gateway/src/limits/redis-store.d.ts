// The Redis store of @fastify/rate-limit (store/RedisStore.js): the package has no type declarations for it.
// Only the parts used by RateLimiter; the signature is the one of version 11.x.
declare module '@fastify/rate-limit/store/RedisStore' {
  import type { FastifyRateLimitStore } from '@fastify/rate-limit';

  class RedisStore {
    /** Defines the commands of its fixed-window script on the client (defineCommand); key = prefix of every counter. */
    constructor(continueExceeding: boolean, exponentialBackoff: boolean, redis: object, key?: string);
    incr: FastifyRateLimitStore['incr'];
  }

  export = RedisStore;
}
