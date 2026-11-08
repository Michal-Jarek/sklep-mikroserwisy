import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { sendError } from './send-error';

/** Global filter: every error thrown in Nest (also 404 for unknown paths) gets the team format. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Pick<Logger, 'error'>) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    sendError(http.getResponse<FastifyReply>(), exception, request.id, this.logger);
  }
}
