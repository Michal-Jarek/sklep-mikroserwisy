import { ValidationPipe } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type { Logger } from 'pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ROUTES } from './routes';

/** Validation and the error format. Used by main.ts and by tests that start the HTTP layer. */
export function setupApp(app: NestFastifyApplication, logger: Pick<Logger, 'error'>): void {
  // Unknown fields are rejected (400 VALIDATION_ERROR), e.g. "roles" in a registration request.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(logger));
}

export function createOpenApiDocument(app: NestFastifyApplication): OpenAPIObject {
  const info = new DocumentBuilder()
    .setTitle('Auth Service')
    .setDescription('Accounts, login and tokens')
    .setVersion('1.0')
    .build();
  return SwaggerModule.createDocument(app, info);
}

/**
 * Swagger UI and the OpenAPI document (paths in routes.ts).
 * Kept out of unit tests: @fastify/static loads an ESM-only package, which Jest cannot require on Node 22.
 */
export function setupSwagger(app: NestFastifyApplication): void {
  SwaggerModule.setup(ROUTES.docs.ui, app, createOpenApiDocument(app), { jsonDocumentUrl: ROUTES.docs.openApi, raw: ['json'] });
}
