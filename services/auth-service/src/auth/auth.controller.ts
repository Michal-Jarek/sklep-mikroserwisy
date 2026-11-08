import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppException } from '../common/app-exception';
import { ErrorResponse } from '../common/error-response';
import { ROUTES } from '../routes';
import { LoginRequest, LoginResponse, RegisterRequest, RegisterResponse } from './auth.dto';
import { AuthService } from './auth.service';
import { clearRefreshCookie, REFRESH_COOKIE_NAME, setRefreshCookie } from './refresh-cookie';

// Decision 18: 5 login requests per 60 s per client IP, in the memory of this instance.
export const LOGIN_RATE_LIMIT = { max: 5, timeWindow: 60_000 };

@ApiTags('auth')
@Controller(ROUTES.auth.base)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** New CUSTOMER account and its profile in User Service. Does not log the user in. */
  @Post(ROUTES.auth.register)
  @ApiCreatedResponse({ type: RegisterResponse })
  @ApiBadRequestResponse({ type: ErrorResponse, description: 'VALIDATION_ERROR' })
  @ApiConflictResponse({ type: ErrorResponse, description: 'EMAIL_TAKEN' })
  @ApiServiceUnavailableResponse({ type: ErrorResponse, description: 'SERVICE_UNAVAILABLE (User Service)' })
  register(@Body() body: RegisterRequest, @Req() request: FastifyRequest): Promise<RegisterResponse> {
    return this.auth.register(body, request.id);
  }

  /** Access token in the body, refresh token only in the refresh_token cookie (HttpOnly, path of the Gateway). */
  @Post(ROUTES.auth.login)
  @HttpCode(200)
  @RouteConfig({ rateLimit: LOGIN_RATE_LIMIT })
  @ApiOkResponse({ type: LoginResponse, description: 'Also Set-Cookie: refresh_token=...; Max-Age=604800' })
  @ApiBadRequestResponse({ type: ErrorResponse, description: 'VALIDATION_ERROR' })
  @ApiUnauthorizedResponse({ type: ErrorResponse, description: 'INVALID_CREDENTIALS' })
  @ApiTooManyRequestsResponse({
    type: ErrorResponse,
    description: 'TOO_MANY_REQUESTS (IP limit) or TOO_MANY_ATTEMPTS (account locked); Retry-After in seconds',
  })
  async login(@Body() body: LoginRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<LoginResponse> {
    const session = await this.auth.login(body);
    setRefreshCookie(reply, session.refreshToken);
    return session.response;
  }

  /** Reads the refresh_token cookie (empty body). The old token is revoked and a new one is set. */
  @Post(ROUTES.auth.refresh)
  @HttpCode(200)
  @ApiOkResponse({ type: LoginResponse, description: 'Also Set-Cookie with the new refresh_token' })
  @ApiUnauthorizedResponse({
    type: ErrorResponse,
    description: 'UNAUTHORIZED: missing, unknown, expired or revoked token; the cookie is cleared',
  })
  async refresh(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<LoginResponse> {
    try {
      const session = await this.auth.refresh(request.cookies[REFRESH_COOKIE_NAME]);
      setRefreshCookie(reply, session.refreshToken);
      return session.response;
    } catch (error) {
      if (error instanceof AppException && error.status === 401) {
        // The browser stops sending a dead token.
        clearRefreshCookie(reply);
      }
      throw error;
    }
  }

  /** Revokes the token family (when the cookie holds a known token) and clears the cookie. Always 204. */
  @Post(ROUTES.auth.logout)
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Set-Cookie: refresh_token=; Max-Age=0' })
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(request.cookies[REFRESH_COOKIE_NAME]);
    clearRefreshCookie(reply);
  }
}
