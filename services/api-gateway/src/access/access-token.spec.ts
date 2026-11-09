import { base64url } from 'jose';
import { bearerToken, tokenKid } from './access-token';

function part(value: unknown): string {
  return base64url.encode(JSON.stringify(value));
}

const PAYLOAD = part({ sub: 'x' });

describe('bearerToken', () => {
  it('takes the token after the Bearer scheme in any case', () => {
    expect(bearerToken('Bearer a.b.c')).toBe('a.b.c');
    expect(bearerToken('bearer a.b.c')).toBe('a.b.c');
    expect(bearerToken('BEARER a.b.c')).toBe('a.b.c');
    expect(bearerToken('Bearer  a-b_c.d~e+f/g==')).toBe('a-b_c.d~e+f/g==');
  });

  it.each(['Bearer', 'Bearer ', 'Basic dXNlcjpwYXNz', 'a.b.c', 'Bearer a b', 'Bearer a,b', 'Bearera.b.c', ''])(
    'returns null for %j',
    (header) => {
      expect(bearerToken(header)).toBeNull();
    },
  );
});

describe('tokenKid', () => {
  it('returns the kid of a well-formed token', () => {
    expect(tokenKid(`${part({ alg: 'RS256', kid: 'k1' })}.${PAYLOAD}.sig`)).toEqual({ kid: 'k1' });
  });

  it('rejects a token without kid or with an empty or non-string kid', () => {
    expect(tokenKid(`${part({ alg: 'RS256' })}.${PAYLOAD}.sig`)).toEqual({ reason: 'missing kid' });
    expect(tokenKid(`${part({ alg: 'RS256', kid: '' })}.${PAYLOAD}.sig`)).toEqual({ reason: 'missing kid' });
    expect(tokenKid(`${part({ alg: 'RS256', kid: 7 })}.${PAYLOAD}.sig`)).toEqual({ reason: 'missing kid' });
  });

  it.each([
    ['abc.def.ghi', 'abc.def.ghi'],
    ['two parts', `${part({ alg: 'RS256', kid: 'k1' })}.${PAYLOAD}`],
    ['payload not JSON', `${part({ alg: 'RS256', kid: 'k1' })}.${base64url.encode('nope')}.sig`],
    ['payload not an object', `${part({ alg: 'RS256', kid: 'k1' })}.${part([1])}.sig`],
    ['header not JSON', `${base64url.encode('nope')}.${PAYLOAD}.sig`],
    ['five parts (JWE)', `${part({ alg: 'RSA-OAEP', enc: 'A256GCM', kid: 'k1' })}.a.b.c.d`],
  ])('rejects a malformed token: %s', (_name, token) => {
    expect(tokenKid(token)).toEqual({ reason: 'malformed token' });
  });
});
