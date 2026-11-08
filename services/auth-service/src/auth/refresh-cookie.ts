import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import { REFRESH_COOKIE_PATH } from '../routes';
import { REFRESH_TOKEN_TTL_SECONDS } from './refresh-token.service';

export const REFRESH_COOKIE_NAME = 'refresh_token';

// Decision 17. The path is the Gateway path of Auth: the browser sees Auth through the Gateway, so the
// cookie is sent only to refresh and logout. Without the Gateway the Cookie header must be set by hand.
const COOKIE_OPTIONS: CookieSerializeOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: REFRESH_COOKIE_PATH,
};

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(REFRESH_COOKIE_NAME, token, { ...COOKIE_OPTIONS, maxAge: REFRESH_TOKEN_TTL_SECONDS });
}

/** Empty value with Max-Age=0 (and Expires in 1970) on the same path, so the browser drops the cookie. */
export function clearRefreshCookie(reply: FastifyReply): void {
  void reply.clearCookie(REFRESH_COOKIE_NAME, COOKIE_OPTIONS);
}
