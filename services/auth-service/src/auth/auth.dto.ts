import { ApiProperty } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsByteLength, IsEmail, IsString, Length, MaxLength } from 'class-validator';
import { ACCESS_TOKEN_TTL_SECONDS } from './token.service';
import { EMAIL_MAX_LENGTH, normalizeEmail, PASSWORD_MAX_BYTES, PASSWORD_MIN_BYTES } from './credentials';

export const NAME_MAX_LENGTH = 100;

// Transforms run before validation; values of other types are left for the validators to reject.
const toEmail = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? normalizeEmail(value) : value);
const trim = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim() : value);

export class RegisterRequest {
  @ApiProperty({ example: 'anna.nowak@example.com', maxLength: EMAIL_MAX_LENGTH, description: 'Trimmed, stored in lower case' })
  @Transform(toEmail)
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email: string;

  @ApiProperty({ example: 'correct-horse-42', description: `${PASSWORD_MIN_BYTES}-${PASSWORD_MAX_BYTES} bytes in UTF-8` })
  @IsString()
  @IsByteLength(PASSWORD_MIN_BYTES, PASSWORD_MAX_BYTES)
  password: string;

  @ApiProperty({ example: 'Anna', minLength: 1, maxLength: NAME_MAX_LENGTH, description: 'Trimmed' })
  @Transform(trim)
  @IsString()
  @Length(1, NAME_MAX_LENGTH)
  firstName: string;

  @ApiProperty({ example: 'Nowak', minLength: 1, maxLength: NAME_MAX_LENGTH, description: 'Trimmed' })
  @Transform(trim)
  @IsString()
  @Length(1, NAME_MAX_LENGTH)
  lastName: string;
}

export class LoginRequest {
  @ApiProperty({ example: 'anna.nowak@example.com', maxLength: EMAIL_MAX_LENGTH })
  @Transform(toEmail)
  @IsEmail()
  @MaxLength(EMAIL_MAX_LENGTH)
  email: string;

  // Up to 72 bytes: bcrypt would ignore the rest, so a longer value could match a shorter password.
  @ApiProperty({ example: 'correct-horse-42' })
  @IsString()
  @IsByteLength(1, PASSWORD_MAX_BYTES)
  password: string;
}

export class RegisterResponse {
  @ApiProperty({ example: '0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e' })
  id: string;

  @ApiProperty({ example: 'anna.nowak@example.com' })
  email: string;

  @ApiProperty({ example: 'Anna' })
  firstName: string;

  @ApiProperty({ example: 'Nowak' })
  lastName: string;

  @ApiProperty({ example: ['CUSTOMER'] })
  roles: string[];
}

export class LoginResponse {
  @ApiProperty({ description: 'JWT (RS256): sub, roles, iss, aud, iat, exp' })
  accessToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({ example: ACCESS_TOKEN_TTL_SECONDS, description: 'Seconds until the access token expires' })
  expiresIn: number;
}

export class JwkResponse {
  @ApiProperty({ example: 'RSA' })
  kty: string;

  @ApiProperty({ description: 'RSA modulus (base64url)' })
  n: string;

  @ApiProperty({ example: 'AQAB' })
  e: string;

  @ApiProperty({ description: 'RFC 7638 thumbprint, same as the "kid" header of the tokens' })
  kid: string;

  @ApiProperty({ example: 'RS256' })
  alg: string;

  @ApiProperty({ example: 'sig' })
  use: string;
}

export class JwksResponse {
  @ApiProperty({ type: [JwkResponse] })
  keys: JwkResponse[];
}
