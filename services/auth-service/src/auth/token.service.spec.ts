import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculateJwkThumbprint, createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { buildConfig, KV_DEFAULTS } from '../config/app-config';
import { loadSigningKey, type SigningKey } from './signing-key';
import { ACCESS_TOKEN_TTL_SECONDS, TokenService } from './token.service';

const ENV = { DB_HOST: 'postgres', DB_NAME: 'auth_db', DB_USER: 'auth_service', DB_PASSWORD: 'test-password' };
const ACCOUNT_ID = '0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e';

describe('signing key, access tokens and JWKS', () => {
  let dir: string;
  let keyFile: string;
  let key: SigningKey;
  let tokens: TokenService;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'auth-key-'));
    keyFile = join(dir, 'jwt-private.pem');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    key = await loadSigningKey(keyFile);
    tokens = new TokenService(key, buildConfig(ENV, KV_DEFAULTS));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the RFC 7638 thumbprint of the public key as kid', async () => {
    const { kty, n, e } = key.publicJwk;
    expect(key.kid).toBe(await calculateJwkThumbprint({ kty, n, e }));
  });

  it('publishes only the public part of the key in JWKS', () => {
    const jwks = tokens.jwks();
    expect(jwks.keys).toHaveLength(1);
    expect(Object.keys(jwks.keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
    expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig', kid: key.kid });
  });

  it('signs an RS256 token with kid, sub, roles, iss, aud and a 900 s lifetime, without email', async () => {
    const token = await tokens.issueAccessToken(ACCOUNT_ID, ['CUSTOMER']);

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'RS256', kid: key.kid });
    const { payload } = await jwtVerify(token, createLocalJWKSet(tokens.jwks()), {
      issuer: 'sklep-auth',
      audience: 'sklep-api',
    });
    expect(payload).toMatchObject({ sub: ACCOUNT_ID, roles: ['CUSTOMER'], iss: 'sklep-auth', aud: 'sklep-api' });
    expect(payload.exp! - payload.iat!).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'roles', 'sub']);
  });

  it('takes issuer and audience from the configuration', async () => {
    const custom = new TokenService(key, buildConfig({ ...ENV, JWT_ISSUER: 'iss-x', JWT_AUDIENCE: 'aud-x' }, KV_DEFAULTS));
    const token = await custom.issueAccessToken(ACCOUNT_ID, ['ADMIN']);
    const { payload } = await jwtVerify(token, createLocalJWKSet(custom.jwks()), { issuer: 'iss-x', audience: 'aud-x' });
    expect(payload.roles).toEqual(['ADMIN']);
  });

  it('rejects a token with a changed payload', async () => {
    const token = await tokens.issueAccessToken(ACCOUNT_ID, ['CUSTOMER']);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: ACCOUNT_ID, roles: ['ADMIN'] })).toString('base64url');
    await expect(jwtVerify(`${header}.${forgedPayload}.${signature}`, createLocalJWKSet(tokens.jwks()))).rejects.toThrow();
  });

  describe('loading errors (the service does not start)', () => {
    async function loadError(path: string): Promise<Error> {
      try {
        await loadSigningKey(path);
      } catch (error) {
        return error as Error;
      }
      throw new Error('expected loadSigningKey to fail');
    }

    it('names the missing file', async () => {
      const error = await loadError(join(dir, 'missing.pem'));
      expect(error.message).toBe(`Cannot load the JWT private key from ${join(dir, 'missing.pem')}`);
      expect((error.cause as Error).message).toContain('ENOENT');
    });

    it('rejects a file that is not a PKCS#8 key, without its content in the error', async () => {
      const badFile = join(dir, 'bad.pem');
      writeFileSync(badFile, 'secret-content-of-a-wrong-file');
      const error = await loadError(badFile);
      expect(error.message).toContain(badFile);
      expect(`${error.message} ${(error.cause as Error).message}`).not.toContain('secret-content');
    });

    it('rejects an empty JWT_PRIVATE_KEY_FILE', async () => {
      await expect(loadSigningKey('')).rejects.toThrow('JWT_PRIVATE_KEY_FILE is not set');
    });
  });
});
