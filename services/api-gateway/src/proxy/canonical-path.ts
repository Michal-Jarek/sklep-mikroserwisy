import { GATEWAY_PREFIX } from '../routes';

/** A proxied request target after the public prefix (decision 8). */
export interface ProxyPath {
  // Decoded segments without the public prefix, e.g. ['products', '12']; empty for the prefix alone.
  segments: string[];
  // Canonical path sent to the service: the segments joined with "/", e.g. /products/12.
  path: string;
  // Raw query without "?", unchanged (e.g. q=a%20b&sort=price); empty when there is none.
  query: string;
}

// RFC 3986 unreserved characters; "." and ".." are rejected separately.
const SEGMENT_PATTERN = /^[A-Za-z0-9._~-]+$/;

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    // Broken percent-encoding, e.g. %zz or a lone byte of a UTF-8 sequence.
    return null;
  }
}

/**
 * Canonical form of a raw request target (request.raw.url, never the URL decoded by Fastify or Nest).
 * Every decoded segment must match [A-Za-z0-9._~-]+ and must not be "." or "..". An empty segment
 * ("//", "/" at the end), ";", %2F, %5C, %00, a space, non-ASCII characters or broken encoding give
 * null (400 VALIDATION_ERROR). Routes and access rules are checked on the decoded segments; the
 * service gets exactly the canonical path and the query as the client sent it.
 */
export function canonicalPath(rawUrl: string): ProxyPath | null {
  const queryStart = rawUrl.indexOf('?');
  const rawPath = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
  const query = queryStart === -1 ? '' : rawUrl.slice(queryStart + 1);

  if (rawPath === GATEWAY_PREFIX) {
    return { segments: [], path: '/', query };
  }
  if (!rawPath.startsWith(`${GATEWAY_PREFIX}/`)) {
    return null;
  }

  const segments: string[] = [];
  for (const raw of rawPath.slice(GATEWAY_PREFIX.length + 1).split('/')) {
    const segment = decodeSegment(raw);
    if (segment === null || !SEGMENT_PATTERN.test(segment) || segment === '.' || segment === '..') {
      return null;
    }
    segments.push(segment);
  }
  return { segments, path: `/${segments.join('/')}`, query };
}

/** Service name for the first segment (exact, case-sensitive match), or undefined when there is no route. */
export function findService(routes: ReadonlyMap<string, string>, segments: readonly string[]): string | undefined {
  return segments.length === 0 ? undefined : routes.get(segments[0]);
}
