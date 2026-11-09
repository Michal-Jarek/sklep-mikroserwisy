import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger, PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { createFastifyAdapter } from './common/fastify-adapter';
import { createLogger } from './common/logger';
import { buildAppConfig, isLogLevel } from './config/app-config';
import { GatewayConfigState } from './config/gateway-config-state.service';
import { ConsulRegistration } from './consul/consul-registration.service';
import { setupCors } from './limits/cors';
import { setupRateLimit } from './limits/setup-rate-limit';
import { setupProxy } from './proxy/setup-proxy';
import { setupApp } from './setup-app';

// Until the configuration from KV is loaded, log with LOG_LEVEL (or info).
const logger = createLogger(isLogLevel(process.env.LOG_LEVEL) ? process.env.LOG_LEVEL : 'info');

async function bootstrap(): Promise<void> {
  const config = buildAppConfig(process.env);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config, logger),
    createFastifyAdapter(config.instanceId, logger),
    // No Nest body parsers: setupApp() reads every body as a Buffer.
    { bufferLogs: true, bodyParser: false },
  );
  // Nest's own logs (startup, routes) go through pino as JSON too.
  app.useLogger(app.get(Logger));
  await setupApp(app, logger);
  // CORS for the origins from KV (none by default): preflights are answered before the proxy route.
  await setupCors(app);
  // Rate limits (@fastify/rate-limit, counters in redis-gateway): applied by the proxy in step 3.
  await setupRateLimit(app);
  // Every /api/v1/** request: checks in the order of the guidelines, then the proxy to a service instance.
  await setupProxy(app);
  // SIGTERM/SIGINT run onApplicationShutdown hooks (Consul deregistration).
  app.enableShutdownHooks();

  // The Gateway listens before the KV configuration is read: until it is loaded, ready answers 503.
  await app.listen({ port: config.port, host: '0.0.0.0' });
  const configState = app.get(GatewayConfigState);
  await configState.start((loaded) => {
    // The request logger of pino-http is a child created at startup: it does not follow the parent level.
    logger.level = loaded.logLevel;
    PinoLogger.root.level = loaded.logLevel;
  });
  await app.get(ConsulRegistration).start(() => Promise.resolve(configState.current() !== null));
  logger.info({ port: config.port, instanceId: config.instanceId }, 'API Gateway started');
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Startup failed');
  process.exit(1);
});
