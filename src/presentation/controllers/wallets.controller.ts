import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  type CreateWalletCommand,
  CreateWalletUseCase,
} from '../../application/use-cases/create-wallet.use-case';
import { QueryWageringUseCase } from '../../application/use-cases/query-and-pending.use-case';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.use-case';

/**
 * Controller REST de Carteiras (Wallets).
 * Em Spring Boot, equivale a @RestController + @RequestMapping("/wallets").
 */
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly queryWageringUseCase: QueryWageringUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async createWallet(
    @Body() body: CreateWalletCommand,
    @Headers('idempotency-key') idempotencyKeyHeader?: string
  ) {
    return this.createWalletUseCase.execute({
      ...body,
      idempotencyKey: body.idempotencyKey ?? idempotencyKeyHeader,
    });
  }

  @Get(':walletId')
  public async getWallet(@Param('walletId') walletId: string) {
    return this.queryWageringUseCase.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  public async listWalletLedger(
    @Param('walletId') walletId: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursor?: string
  ) {
    const limit = limitStr ? Number.parseInt(limitStr, 10) : 50;
    return this.queryWageringUseCase.listWalletLedger(walletId, limit, cursor);
  }

  @Post(':walletId/reconcile')
  @HttpCode(HttpStatus.OK)
  public async reconcileWallet(@Param('walletId') walletId: string) {
    return this.reconcileWalletUseCase.execute(walletId);
  }
}
