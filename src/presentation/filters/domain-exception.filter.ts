import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  DuplicateWalletError,
  EntityNotFoundError,
  ExternalTransactionConflictError,
} from '../../application/errors/application-errors';
import { InvalidLedgerEntryError } from '../../domain/ledger/ledger-entry';
import { CurrencyMismatchError, InvalidMoneyError } from '../../domain/money/money';
import {
  IdempotencyConflictError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../domain/transaction/wager-transaction';
import {
  InsufficientFundsError,
  InvalidWalletOperationError,
} from '../../domain/wallet/wallet';

/**
 * Filtro Global de Excecoes do NestJS.
 * Em Java / Spring Boot, equivale exatamente a uma classe anotada com @RestControllerAdvice
 * contendo varios metodos @ExceptionHandler(...).
 *
 * Traduz erros de Dominio e Aplicacao para status HTTP padronizados:
 * - 400 Bad Request: formato monetario invalido, operacao invalida
 * - 404 Not Found: carteira ou transacao nao encontrada
 * - 409 Conflict: conflito de idempotencia (mesma chave com payload diferente) ou duplicidade
 * - 422 Unprocessable Entity: violacao de invariante de negocio
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{ status: (code: number) => { json: (body: unknown) => void } }>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json(exception.getResponse());
      return;
    }

    if (exception instanceof EntityNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        error: 'NOT_FOUND',
        code: exception.name,
        message: exception.message,
      });
      return;
    }

    if (
      exception instanceof IdempotencyConflictError ||
      exception instanceof DuplicateWalletError ||
      exception instanceof ExternalTransactionConflictError
    ) {
      response.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'CONFLICT',
        code: exception.name,
        message: exception.message,
      });
      return;
    }

    if (
      exception instanceof InvalidMoneyError ||
      exception instanceof CurrencyMismatchError ||
      exception instanceof InvalidWalletOperationError ||
      exception instanceof InvalidWagerTransactionError
    ) {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'BAD_REQUEST',
        code: exception.name,
        message: exception.message,
      });
      return;
    }

    if (
      exception instanceof InsufficientFundsError ||
      exception instanceof InvalidTransactionStateError ||
      exception instanceof InvalidLedgerEntryError
    ) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'UNPROCESSABLE_ENTITY',
        code: exception.name,
        message: exception.message,
      });
      return;
    }

    const message = exception instanceof Error ? exception.message : 'Internal server error';
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'INTERNAL_SERVER_ERROR',
      message,
    });
  }
}
