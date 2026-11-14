import { Test, type TestingModule } from '@nestjs/testing';
import { Agent, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import { pino } from 'pino';
import { loggerModuleParams } from '../common/logger';
import { buildAppConfig } from '../config/app-config';
import { AppConfigModule } from '../config/app-config.module';
import { METRICS_PATH } from '../routes';
import { GatewayMetrics } from './gateway-metrics';
import { MetricsModule } from './metrics.module';
import { MetricsServer } from './metrics-server.service';

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function send(port: number, method: string, path: string, agent: Agent | false = false): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** The module as main.ts gets it: MetricsModule with the static configuration (INSTANCE_ID) and the logger. */
async function createModule(): Promise<TestingModule> {
  const config = buildAppConfig({ REDIS_PASSWORD: 'test-redis', INSTANCE_ID: 'api-gateway-m1' });
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule.register(config), LoggerModule.forRoot(loggerModuleParams(pino({ level: 'silent' }))), MetricsModule],
  }).compile();
  return moduleRef.init();
}

describe('MetricsServer (stage 9b, decision 5)', () => {
  let moduleRef: TestingModule;
  let port: number;

  beforeAll(async () => {
    moduleRef = await createModule();
    port = await moduleRef.get(MetricsServer).start(0, '127.0.0.1');
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it(`GET ${METRICS_PATH} -> 200 with the content type of the registry and gateway_instance from INSTANCE_ID`, async () => {
    moduleRef.get(GatewayMetrics).recordResponse('none', 'GET', 404, 0.001);
    const result = await send(port, 'GET', METRICS_PATH);
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(result.text).toContain('gateway_http_requests_total{service="none",method="GET",code="404",gateway_instance="api-gateway-m1"} 1');
    expect(result.text).toContain('# TYPE process_resident_memory_bytes gauge');
  });

  it('HEAD -> 200 without a body; a query string does not change the path', async () => {
    const head = await send(port, 'HEAD', METRICS_PATH);
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(head.text).toBe('');
    expect((await send(port, 'GET', `${METRICS_PATH}?x=1`)).status).toBe(200);
  });

  it.each(['/', `${METRICS_PATH}/`, `${METRICS_PATH}x`, '/health/ready', '/api/v1/products'])('GET %s -> 404 with a short text', async (path) => {
    const result = await send(port, 'GET', path);
    expect(result.status).toBe(404);
    expect(result.text).toBe('Not found\n');
  });

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS', 'PROPFIND'])(`%s ${METRICS_PATH} -> 405 with Allow`, async (method) => {
    const result = await send(port, method, METRICS_PATH);
    expect(result.status).toBe(405);
    expect(result.headers.allow).toBe('GET, HEAD');
    expect(result.text).toBe('Method not allowed\n');
  });

  it('closes in the shutdown of the application, also with an open keep-alive connection (K8, R8)', async () => {
    const other = await createModule();
    const server = other.get(MetricsServer);
    const otherPort = await server.start(0, '127.0.0.1');
    const agent = new Agent({ keepAlive: true });
    expect((await send(otherPort, 'GET', METRICS_PATH, agent)).status).toBe(200);

    await other.close();
    await expect(send(otherPort, 'GET', METRICS_PATH)).rejects.toThrow(/ECONNREFUSED/);
    agent.destroy();
  });

  it('a port in use stops the start', async () => {
    const other = await createModule();
    await expect(other.get(MetricsServer).start(port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
    await other.close();
  });
});
