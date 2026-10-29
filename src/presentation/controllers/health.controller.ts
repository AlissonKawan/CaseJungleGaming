import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import {
  WAGERING_UNIT_OF_WORK,
  type WageringUnitOfWorkPort,
} from '../../application/ports/wagering-unit-of-work.port';
import { SqsWageringMessagingService } from '../../infrastructure/messaging/sqs-wagering.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(WAGERING_UNIT_OF_WORK)
    private readonly uow: WageringUnitOfWorkPort,
    private readonly sqsService: SqsWageringMessagingService
  ) {}

  @Get('live')
  public getLiveness() {
    return {
      status: 'ALIVE',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  public async getReadiness(
    @Res({ passthrough: true }) res?: { status: (code: number) => void }
  ) {
    const [dbReady, sqsReady] = await Promise.all([
      this.uow.ping(),
      this.sqsService.pingQueue(),
    ]);

    const ready = dbReady && sqsReady;
    if (!ready && res) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: ready ? 'READY' : 'NOT_READY',
      checks: {
        postgres: dbReady ? 'UP' : 'DOWN',
        sqs: sqsReady ? 'UP' : 'DOWN',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
