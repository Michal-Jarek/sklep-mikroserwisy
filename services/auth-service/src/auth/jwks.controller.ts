import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ROUTES } from '../routes';
import { JwksResponse } from './auth.dto';
import { TokenService } from './token.service';

@ApiTags('jwks')
@Controller(ROUTES.jwks.base)
export class JwksController {
  constructor(private readonly tokens: TokenService) {}

  /** Public key for verifying access tokens (Gateway). Only kty, n, e, kid, alg, use. */
  @Get(ROUTES.jwks.document)
  @ApiOkResponse({ type: JwksResponse })
  jwks(): JwksResponse {
    return this.tokens.jwks();
  }
}
