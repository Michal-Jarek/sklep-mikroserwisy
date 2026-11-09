import type { AccessLevel, AccessRule } from '../config/gateway-config';

// Level of a request that no rule matches (decision 15).
export const DEFAULT_ACCESS: AccessLevel = 'authenticated';

/** "*" = exactly one segment, "**" (last only, checked by the config validator) = zero or more segments. Case-sensitive. */
export function patternMatches(pattern: readonly string[], segments: readonly string[]): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index];
    if (part === '**') {
      return true;
    }
    if (index >= segments.length || (part !== '*' && part !== segments[index])) {
      return false;
    }
  }
  return pattern.length === segments.length;
}

/** A rule for GET covers HEAD too: services answer HEAD with their GET handler (e.g. Spring). */
export function methodMatches(methods: AccessRule['methods'], method: string): boolean {
  if (methods === 'ANY') {
    return true;
  }
  const listed = methods as readonly string[];
  return listed.includes(method) || (method === 'HEAD' && listed.includes('GET'));
}

/** Access level of the first matching rule; without a match the request needs a login. */
export function accessLevel(rules: readonly AccessRule[], method: string, segments: readonly string[]): AccessLevel {
  const rule = rules.find((item) => methodMatches(item.methods, method) && patternMatches(item.pattern, segments));
  return rule?.access ?? DEFAULT_ACCESS;
}
