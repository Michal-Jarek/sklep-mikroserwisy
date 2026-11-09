import fastifyHelmet from '@fastify/helmet';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { BODY_LIMIT_BYTES } from './common/fastify-adapter';

// The API serves no HTML: nothing may be loaded or framed (decision 19). Other helmet headers keep their defaults.
export const HELMET_OPTIONS = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  },
};

/**
 * Security headers, the request body parser and the error format. Used by main.ts and by tests that
 * start the HTTP layer. The Nest application must be created with { bodyParser: false }.
 */
export async function setupApp(app: NestFastifyApplication, logger: Pick<Logger, 'error'>): Promise<void> {
  // Helmet sets its headers in an onRequest hook, so they are on every response (also errors and 404).
  await app.register(fastifyHelmet, HELMET_OPTIONS);
  // The Gateway does not parse bodies (decision 10): every content type is read as a Buffer, up to 1 MiB.
  const fastify = app.getHttpAdapter().getInstance();
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT_BYTES }, (_request, body, done) => {
    done(null, body);
  });
  app.useGlobalFilters(new AllExceptionsFilter(logger));
}
