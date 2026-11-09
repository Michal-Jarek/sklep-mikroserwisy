import { ArgumentsHost, Catch, ExceptionFilter, NotFoundException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { AppException } from './app-exception';
import { sendError } from './send-error';

/**
 * Methods registered for the request path, when the request method is not one of them (decision D7).
 * The routes come from the controllers (paths from routes.ts), so no second list of paths or methods.
 * Empty when the path is unknown or the method has a route (a 404 thrown by the handler itself).
 */
function otherMethodsOfPath(request: FastifyRequest): string[] {
  const url = request.url.split('?')[0];
  const fastify = request.server;
  const methods = fastify.supportedMethods.filter((method) => fastify.hasRoute({ method, url }));
  return methods.includes(request.method) ? [] : methods;
}

/**
 * Global filter: every error thrown in Nest gets the team format. A request without a route ends here
 * as 404: on an existing path with another method it becomes 405 METHOD_NOT_ALLOWED with Allow.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Pick<Logger, 'error'>) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const allowed = exception instanceof NotFoundException ? otherMethodsOfPath(request) : [];
    if (allowed.length > 0) {
      void reply.header('Allow', allowed.join(', '));
      sendError(reply, new AppException(405, 'METHOD_NOT_ALLOWED', 'Method not allowed'), request.id, this.logger);
      return;
    }
    sendError(reply, exception, request.id, this.logger);
  }
}
