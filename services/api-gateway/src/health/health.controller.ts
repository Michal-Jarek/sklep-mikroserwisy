import { Controller, Get } from '@nestjs/common';
import { AppException, ERROR_MESSAGES } from '../common/app-exception';
import { GatewayConfigState } from '../config/gateway-config-state.service';
import { ROUTES } from '../routes';

export interface HealthStatus {
  status: 'UP';
}

@Controller(ROUTES.health.base)
export class HealthController {
  constructor(private readonly configState: GatewayConfigState) {}

  /** The process is alive. Does not check dependencies. */
  @Get(ROUTES.health.live)
  live(): HealthStatus {
    return { status: 'UP' };
  }

  /**
   * Ready for traffic when the configuration from Consul KV is loaded. Redis, Consul (after loading)
   * and Auth Service are not required. Used by Consul and the container health check.
   */
  @Get(ROUTES.health.ready)
  ready(): HealthStatus {
    if (this.configState.current() === null) {
      throw new AppException(503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.serviceUnavailable);
    }
    return { status: 'UP' };
  }
}
