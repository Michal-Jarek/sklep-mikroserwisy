import type { AccessRule } from '../config/gateway-config';
import { accessLevel, methodMatches, patternMatches } from './access-rules';

function rule(methods: AccessRule['methods'], path: string, access: AccessRule['access']): AccessRule {
  return { methods, pattern: path.slice(1).split('/'), access };
}

describe('patternMatches', () => {
  it.each([
    [['products'], ['products'], true],
    [['products'], ['products', 'p1'], false],
    [['products'], [], false],
    [['products', '*'], ['products', 'p1'], true],
    [['products', '*'], ['products'], false],
    [['products', '*'], ['products', 'p1', 'x'], false],
    [['shipments', '*', 'status'], ['shipments', 's1', 'status'], true],
    [['shipments', '*', 'status'], ['shipments', 's1', 'other'], false],
    [['products', '**'], ['products'], true],
    [['products', '**'], ['products', 'p1'], true],
    [['products', '**'], ['products', 'p1', 'a', 'b'], true],
    [['products', '**'], ['categories'], false],
    [['products', '**'], [], false],
    [['Products'], ['products'], false],
    [['products'], ['Products'], false],
  ])('%j against %j -> %s', (pattern, segments, expected) => {
    expect(patternMatches(pattern, segments)).toBe(expected);
  });
});

describe('methodMatches', () => {
  it('matches listed methods, ANY matches everything', () => {
    expect(methodMatches(['GET'], 'GET')).toBe(true);
    expect(methodMatches(['GET'], 'POST')).toBe(false);
    expect(methodMatches('ANY', 'DELETE')).toBe(true);
    expect(methodMatches('ANY', 'HEAD')).toBe(true);
  });

  it('a rule for GET covers HEAD (served by the GET handler), not the other way round', () => {
    expect(methodMatches(['GET'], 'HEAD')).toBe(true);
    expect(methodMatches(['GET', 'HEAD'], 'HEAD')).toBe(true);
    expect(methodMatches(['HEAD'], 'GET')).toBe(false);
    expect(methodMatches(['POST'], 'HEAD')).toBe(false);
  });

  it('HEAD gets the level of a rule for GET: [GET] blocked -> HEAD blocked (N2)', () => {
    const rules = [rule(['GET'], '/orders/purchased/**', 'blocked'), rule('ANY', '/orders/**', 'authenticated')];
    expect(accessLevel(rules, 'HEAD', ['orders', 'purchased'])).toBe('blocked');
    expect(accessLevel(rules, 'HEAD', ['orders', 'o1'])).toBe('authenticated');
  });
});

describe('accessLevel', () => {
  it('takes the first matching rule', () => {
    const rules = [rule(['GET'], '/users/me/**', 'authenticated'), rule(['GET'], '/users/*', 'ADMIN')];
    expect(accessLevel(rules, 'GET', ['users', 'me'])).toBe('authenticated');
    expect(accessLevel(rules, 'GET', ['users', 'u1'])).toBe('ADMIN');
    expect(accessLevel([...rules].reverse(), 'GET', ['users', 'me'])).toBe('ADMIN');
  });

  it('defaults to authenticated without a match (also for an empty list)', () => {
    expect(accessLevel([rule(['GET'], '/products/**', 'public')], 'POST', ['products'])).toBe('authenticated');
    expect(accessLevel([], 'GET', ['anything'])).toBe('authenticated');
  });

  it('skips a rule whose method does not match', () => {
    const rules = [rule(['POST'], '/users', 'blocked'), rule('ANY', '/users/**', 'public')];
    expect(accessLevel(rules, 'POST', ['users'])).toBe('blocked');
    expect(accessLevel(rules, 'GET', ['users'])).toBe('public');
  });
});
