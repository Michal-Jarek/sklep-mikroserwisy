// Input validation of the mocks, as described in docs/frontend-api.md. Every failure is 400 VALIDATION_ERROR.
import { badRequest, isUuid } from './http';

export type JsonObject = Record<string, unknown>;

/** JSON object with only the allowed keys (unknown fields -> 400, as in Auth, User and Cart). */
export async function readBody(request: Request, allowed: string[]): Promise<JsonObject> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest('Request body must be JSON');
  }
  return objectWith(body, allowed, 'body');
}

export function objectWith(value: unknown, allowed: string[], name: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`${name} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw badRequest(`Unknown fields: ${unknown.join(', ')}`);
  }
  return value as JsonObject;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Trimmed text with a length range; `plain` also rejects control characters. */
export function text(value: unknown, name: string, min: number, max: number, plain = false): string {
  if (typeof value !== 'string') {
    throw badRequest(`${name} must be text`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max || (plain && CONTROL_CHARS.test(trimmed))) {
    throw badRequest(`${name} must have ${min}-${max} characters`);
  }
  return trimmed;
}

export function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${name} must be an integer ${min}-${max}`);
  }
  return value;
}

export function uuid(value: unknown, name: string): string {
  if (!isUuid(value)) {
    throw badRequest(`${name} must be a UUID`);
  }
  return value;
}

export function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(`${name} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Integer query parameter; absent -> fallback. */
export function queryInteger(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw badRequest(`${name} must be an integer ${min}-${max}`);
  }
  return integer(Number(raw), name, min, max);
}

export interface PageRequest {
  page: number;
  size: number;
}

export function pageRequest(url: URL): PageRequest {
  return {
    page: queryInteger(url, 'page', 1, 1, 1_000_000),
    size: queryInteger(url, 'size', 20, 1, 100),
  };
}

export function pageOf<T>(all: T[], { page, size }: PageRequest): { items: T[]; page: number; size: number; total: number } {
  return { items: all.slice((page - 1) * size, page * size), page, size, total: all.length };
}

/** Path parameter that must be a UUID (D1: invalid -> 400). */
export function pathUuid(params: Record<string, string>, name: string): string {
  return uuid(params[name], name);
}

/** Newest first by an ISO 8601 UTC field. */
export function newestFirst<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
