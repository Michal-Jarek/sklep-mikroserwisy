import { DynamicModule, Module } from '@nestjs/common';
import { UserClientModule } from '../user-client/user-client.module';
import { AdminAccountInitializer } from './admin-account.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwksController } from './jwks.controller';
import { LoginAttemptsService } from './login-attempts.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { SIGNING_KEY, type SigningKey } from './signing-key';
import { TokenService } from './token.service';

@Module({})
export class AuthModule {
  /** The signing key is loaded in main.ts before Nest starts (a bad key file stops the service). */
  static register(signingKey: SigningKey): DynamicModule {
    return {
      module: AuthModule,
      imports: [UserClientModule],
      controllers: [AuthController, JwksController],
      providers: [
        AuthService,
        TokenService,
        RefreshTokenService,
        LoginAttemptsService,
        AdminAccountInitializer,
        { provide: PasswordService, useFactory: () => new PasswordService() },
        { provide: SIGNING_KEY, useValue: signingKey },
      ],
    };
  }
}
