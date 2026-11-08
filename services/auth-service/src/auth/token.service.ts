import { Inject, Injectable } from '@nestjs/common';
import { SignJWT } from 'jose';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { type PublicJwk, SIGNING_ALGORITHM, SIGNING_KEY, type SigningKey } from './signing-key';

export const ACCESS_TOKEN_TTL_SECONDS = 900;

/** Access tokens (RS256) and the JWKS document that the Gateway uses to verify them. */
@Injectable()
export class TokenService {
  constructor(
    @Inject(SIGNING_KEY) private readonly key: SigningKey,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Claims: sub (account id), roles, iss, aud, iat, exp = iat + 900. No email in the token. */
  issueAccessToken(accountId: string, roles: string[]): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000);
    return new SignJWT({ roles })
      .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: this.key.kid, typ: 'JWT' })
      .setSubject(accountId)
      .setIssuer(this.config.jwt.issuer)
      .setAudience(this.config.jwt.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.key.privateKey);
  }

  jwks(): { keys: PublicJwk[] } {
    return { keys: [this.key.publicJwk] };
  }
}
