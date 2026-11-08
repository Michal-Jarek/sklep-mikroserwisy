import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import type { ServiceDiscovery } from '../consul/service-discovery.service';
import { USER_SERVICE_USERS_PATH } from '../routes';
import { ATTEMPT_TIMEOUT_MS, UserClient, type UserProfile } from './user-client.service';

const PROFILE: UserProfile = {
  id: '0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e',
  email: 'anna@example.com',
  firstName: 'Anna',
  lastName: 'Nowak',
};

type Answer = number | Error;

function mockUserService(...answers: Answer[]) {
  let call = 0;
  return jest.spyOn(global, 'fetch').mockImplementation(() => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(new Response(null, { status: answer }));
  });
}

function timeoutError(): Error {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

describe('UserClient', () => {
  let client: UserClient;
  let getInstance: jest.Mock<(name: string) => Promise<string | null>>;
  const logger = { warn: jest.fn(), info: jest.fn() };

  function createClient() {
    getInstance = jest.fn<(name: string) => Promise<string | null>>().mockResolvedValue('http://10.0.0.5:8082');
    client = new UserClient({ getInstance } as unknown as ServiceDiscovery, logger as unknown as PinoLogger);
  }

  async function expect503(promise: Promise<void>) {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
  }

  beforeEach(createClient);

  afterEach(() => {
    client.onModuleDestroy();
    jest.restoreAllMocks();
    logger.warn.mockReset();
  });

  it(`sends POST ${USER_SERVICE_USERS_PATH} with the headers and body from the contract`, async () => {
    const fetchSpy = mockUserService(201);

    await client.createProfile(PROFILE, 'req-1');

    expect(getInstance).toHaveBeenCalledWith('user-service');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://10.0.0.5:8082${USER_SERVICE_USERS_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-User-Id': PROFILE.id,
      'X-User-Roles': 'SERVICE',
      'X-Request-Id': 'req-1',
    });
    expect(JSON.parse(init.body as string)).toEqual(PROFILE);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(ATTEMPT_TIMEOUT_MS).toBe(2000);
  });

  it('accepts 200 as success', async () => {
    mockUserService(200);
    await expect(client.createProfile(PROFILE, 'req-1')).resolves.toBeUndefined();
  });

  it.each([
    ['5xx', 500],
    ['timeout', timeoutError()],
    ['network error', new TypeError('fetch failed')],
  ])('retries once after %s with the same id', async (_name, firstAnswer) => {
    const fetchSpy = mockUserService(firstAnswer, 201);

    await client.createProfile(PROFILE, 'req-1');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const bodies = fetchSpy.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as UserProfile);
    expect(bodies[0].id).toBe(PROFILE.id);
    expect(bodies[1].id).toBe(PROFILE.id);
  });

  it('returns 503 when the retry fails too', async () => {
    const fetchSpy = mockUserService(500, 503);
    await expect503(client.createProfile(PROFILE, 'req-1'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx and returns 503', async () => {
    const fetchSpy = mockUserService(409);
    await expect503(client.createProfile(PROFILE, 'req-1'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns 503 without a call when Consul has no healthy instance', async () => {
    const fetchSpy = mockUserService(201);
    getInstance.mockResolvedValue(null);
    await expect503(client.createProfile(PROFILE, 'req-1'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('opens the breaker after 10 failed calls and then rejects without calling User Service', async () => {
    // 408 counts as a failure and is not retried, so each call is one request.
    const fetchSpy = mockUserService(408);
    for (let i = 0; i < 10; i += 1) {
      await expect503(client.createProfile(PROFILE, `req-${i}`));
    }
    expect(fetchSpy).toHaveBeenCalledTimes(10);

    await expect503(client.createProfile(PROFILE, 'req-11'));
    expect(fetchSpy).toHaveBeenCalledTimes(10);
    expect(logger.warn).toHaveBeenCalledWith(
      { targetService: 'user-service' },
      'Circuit breaker opened, User Service calls are rejected for 30 s',
    );
  });

  it('does not count 409 as a failure of User Service', async () => {
    const fetchSpy = mockUserService(409);
    for (let i = 0; i < 12; i += 1) {
      await expect503(client.createProfile(PROFILE, `req-${i}`));
    }
    // The breaker stayed closed: every call reached User Service.
    expect(fetchSpy).toHaveBeenCalledTimes(12);
  });
});
