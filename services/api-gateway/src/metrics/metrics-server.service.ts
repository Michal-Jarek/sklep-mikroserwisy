import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { METRICS_PATH } from '../routes';
import { GatewayMetrics } from './gateway-metrics';

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(text);
}

/**
 * Separate node:http server for Prometheus (stage 9b, decision 5): only GET/HEAD METRICS_PATH, other paths 404,
 * other methods 405. Not on the API port (the Ingress never reaches it), not registered in Consul. Closed in the
 * shutdown of the application, otherwise the process (PID 1 in the container) would not end after SIGTERM.
 */
@Injectable()
export class MetricsServer implements OnApplicationShutdown {
  private server?: Server;

  constructor(
    private readonly metrics: GatewayMetrics,
    @InjectPinoLogger(MetricsServer.name) private readonly logger: PinoLogger,
  ) {}

  /** Listens on the port (METRICS_PORT in main.ts, 0 in tests) and returns the bound port. */
  async start(port: number, host = '0.0.0.0'): Promise<number> {
    const server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    return (server.address() as AddressInfo).port;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if ((req.url ?? '').split('?', 1)[0] !== METRICS_PATH) {
      sendText(res, 404, 'Not found\n');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
      return;
    }
    const registry = this.metrics.registry;
    registry.metrics().then(
      (body) => {
        res.writeHead(200, { 'Content-Type': registry.contentType });
        res.end(req.method === 'HEAD' ? undefined : body);
      },
      (error: unknown) => {
        this.logger.error({ err: error }, 'Collecting metrics failed');
        sendText(res, 500, 'Internal error\n');
      },
    );
  }

  /** Stops listening and drops open connections (a scrape keeps a keep-alive connection). */
  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
}
