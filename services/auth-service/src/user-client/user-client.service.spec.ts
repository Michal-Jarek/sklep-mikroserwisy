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

function connectionRefused(): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
}

const FIRST = 'http://10.0.0.5:8082';
const SECOND = 'http://10.0.0.6:8082';

/** Answers by instance: the first one refuses connections, the second one answers 201. */
function mockTwoInstances() {
  return jest.spyOn(global, 'fetch').mockImplementation((url) =>
    (url as string).startsWith(FIRST) ? Promise.reject(connectionRefused()) : Promise.resolve(new Response(null, { status: 201 })),
  );
}

function callsTo(fetchSpy: ReturnType<typeof mockTwoInstances>, baseUrl: string): UserProfile[] {
  return fetchSpy.mock.calls
    .filter(([url]) => (url as string) === `${baseUrl}${USER_SERVICE_USERS_PATH}`)
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as UserProfile);
}

describe('UserClient', () => {
  let client: UserClient;
  let getInstance: jest.Mock<(name: string) => Promise<string | null>>;
  let evict: jest.Mock<(name: string, baseUrl: string) => void>;
  const logger = { warn: jest.fn(), info: jest.fn() };

  function createClient() {
    getInstance = jest.fn<(name: string) => Promise<string | null>>().mockResolvedValue(FIRST);
    evict = jest.fn<(name: string, baseUrl: string) => void>();
    client = new UserClient({ getInstance, evict } as unknown as ServiceDiscovery, logger as unknown as PinoLogger);
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

  it('evicts an instance that refuses the connection and retries once on the next instance with the same id', async () => {
    const fetchSpy = mockTwoInstances();
    getInstance.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(SECOND);

    await client.createProfile(PROFILE, 'req-1');

    expect(evict).toHaveBeenCalledTimes(1);
    expect(evict).toHaveBeenCalledWith('user-service', FIRST);
    expect(getInstance).toHaveBeenCalledTimes(2);
    expect(callsTo(fetchSpy, FIRST)).toHaveLength(1);
    const second = callsTo(fetchSpy, SECOND);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(PROFILE.id);
  });

  it.each([
    ['no instance is left', null],
    ['Consul returns the same instance', FIRST],
  ])('retries on the same address when %s', async (_name, next) => {
    const fetchSpy = mockUserService(connectionRefused(), 201);
    getInstance.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(next);

    await client.createProfile(PROFILE, 'req-1');

    expect(evict).toHaveBeenCalledWith('user-service', FIRST);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map(([url]) => (url as string))).toEqual([
      `${FIRST}${USER_SERVICE_USERS_PATH}`,
      `${FIRST}${USER_SERVICE_USERS_PATH}`,
    ]);
  });

  it('evicts both instances and returns 503 when the next instance refuses the connection too', async () => {
    const fetchSpy = mockUserService(connectionRefused());
    getInstance.mockResolvedValueOnce(FIRST).mockResolvedValueOnce(SECOND);

    await expect503(client.createProfile(PROFILE, 'req-1'));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(evict.mock.calls).toEqual([
      ['user-service', FIRST],
      ['user-service', SECOND],
    ]);
  });

  it.each([
    ['5xx', 500],
    ['timeout', timeoutError()],
  ])('retries on the same instance without eviction after %s', async (_name, firstAnswer) => {
    const fetchSpy = mockUserService(firstAnswer, 201);

    await client.createProfile(PROFILE, 'req-1');

    expect(evict).not.toHaveBeenCalled();
    expect(getInstance).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.map(([url]) => (url as string))).toEqual([
      `${FIRST}${USER_SERVICE_USERS_PATH}`,
      `${FIRST}${USER_SERVICE_USERS_PATH}`,
    ]);
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
