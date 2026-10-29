import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from '../../application/use-cases/process-wager-transaction.use-case';
import {
  QueryWageringUseCase,
  ResolvePendingReferencesUseCase,
} from '../../application/use-cases/query-and-pending.use-case';

/**
 * Controller REST de Transacoes de Apostas (Wager Transactions).
 * Em Spring Boot, equivale a @RestController.
 */
@Controller()
export class TransactionsController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly queryWageringUseCase: QueryWageringUseCase,
    private readonly resolvePendingReferencesUseCase: ResolvePendingReferencesUseCase
  ) {}

  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  public async processTransaction(
    @Body() body: ProcessWagerTransactionCommand,
    @Headers('idempotency-key') idempotencyKeyHeader?: string
  ) {
    return this.processWagerUseCase.execute({
      ...body,
      idempotencyKey: body.idempotencyKey || idempotencyKeyHeader || '',
    });
  }

  @Get('transactions/:transactionId')
  public async getTransactionById(@Param('transactionId') transactionId: string) {
    return this.queryWageringUseCase.getTransactionById(transactionId);
  }

  @Get('providers/:providerId/transactions/:externalTransactionId')
  public async getTransactionByProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string
  ) {
    return this.queryWageringUseCase.getTransactionByProviderAndExternalId(
      providerId,
      externalTransactionId
    );
  }

  @Post('transactions/pending-references/resolve')
  @HttpCode(HttpStatus.OK)
  public async resolvePendingReferences(@Body() body?: { limit?: number; maxAgeMs?: number }) {
    return this.resolvePendingReferencesUseCase.execute(body ?? {});
  }
}
