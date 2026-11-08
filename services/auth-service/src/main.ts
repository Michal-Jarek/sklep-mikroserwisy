import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadSigningKey } from './auth/signing-key';
import { createFastifyAdapter } from './common/fastify-adapter';
import { registerFastifyPlugins } from './common/fastify-plugins';
import { createLogger } from './common/logger';
import { isLogLevel } from './config/app-config';
import { loadConfig } from './config/load-config';
import { ConsulRegistration } from './consul/consul-registration.service';
import { Readiness } from './health/readiness.service';
import { setupApp, setupSwagger } from './setup-app';

// Until the configuration is loaded, log with LOG_LEVEL (or info).
const logger = createLogger(isLogLevel(process.env.LOG_LEVEL) ? process.env.LOG_LEVEL : 'info');

async function bootstrap(): Promise<void> {
  const config = await loadConfig(process.env, logger);
  logger.level = config.logLevel;
  // Before Nest: a missing or invalid key file stops the service with one JSON log line.
  const signingKey = await loadSigningKey(config.jwtPrivateKeyFile);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config, logger, signingKey),
    createFastifyAdapter(config.instanceId),
    { bufferLogs: true },
  );
  // Nest's own logs (startup, routes) go through pino as JSON too.
  app.useLogger(app.get(Logger));
  // Cookies and the login rate limit, before listen() registers the routes.
  await registerFastifyPlugins(app);
  setupApp(app, logger);
  setupSwagger(app);
  // SIGTERM/SIGINT run onApplicationShutdown hooks (Consul deregistration).
  app.enableShutdownHooks();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  const readiness = app.get(Readiness);
  await app.get(ConsulRegistration).start(() => readiness.check());
  logger.info({ port: config.port, instanceId: config.instanceId }, 'Auth Service started');
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Startup failed');
  process.exit(1);
});
