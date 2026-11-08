import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { AppException } from '../common/app-exception';
import { ErrorResponse } from '../common/error-response';
import { ROUTES } from '../routes';
import { Readiness } from './readiness.service';

export class HealthStatus {
  @ApiProperty({ example: 'UP' })
  status: 'UP';
}

@ApiTags('health')
@Controller(ROUTES.health.base)
export class HealthController {
  constructor(private readonly readiness: Readiness) {}

  /** The process is alive. Does not check dependencies. */
  @Get(ROUTES.health.live)
  @ApiOkResponse({ type: HealthStatus })
  live(): HealthStatus {
    return { status: 'UP' };
  }

  /** Ready for traffic when the database answers. Used by Consul and the container health check. */
  @Get(ROUTES.health.ready)
  @ApiOkResponse({ type: HealthStatus })
  @ApiServiceUnavailableResponse({ type: ErrorResponse })
  async ready(): Promise<HealthStatus> {
    if (!(await this.readiness.check())) {
      throw new AppException(503, 'SERVICE_UNAVAILABLE', 'Database is not reachable');
    }
    return { status: 'UP' };
  }
}
