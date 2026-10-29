import { type DynamicModule, Module } from '@nestjs/common';
import {
  WAGERING_UNIT_OF_WORK,
  type WageringUnitOfWorkPort,
} from './application/ports/wagering-unit-of-work.port';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { ProcessWagerTransactionUseCase } from './application/use-cases/process-wager-transaction.use-case';
import {
  QueryWageringUseCase,
  ResolvePendingReferencesUseCase,
} from './application/use-cases/query-and-pending.use-case';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { InMemoryWageringUnitOfWork } from './infrastructure/database/in-memory-unit-of-work';
import { PostgresWageringUnitOfWork } from './infrastructure/database/postgres-unit-of-work';
import { SqsWageringMessagingService } from './infrastructure/messaging/sqs-wagering.service';
import { HealthController } from './presentation/controllers/health.controller';
import { TransactionsController } from './presentation/controllers/transactions.controller';
import { WalletsController } from './presentation/controllers/wallets.controller';

/**
 * Modulo Raiz do NestJS (AppModule).
 * Em Spring Boot, equivale a classe principal anotada com @SpringBootApplication + @Configuration,
 * onde registramos os @Beans (providers) e os @RestControllers (controllers).
 */
@Module({})
export class AppModule {
  public static register(options?: {
    unitOfWork?: WageringUnitOfWorkPort;
    useInMemoryDb?: boolean;
  }): DynamicModule {
    const useInMemory =
      options?.useInMemoryDb ?? process.env.USE_IN_MEMORY_DB === 'true';

    const uowProvider = options?.unitOfWork
      ? {
          provide: WAGERING_UNIT_OF_WORK,
          useValue: options.unitOfWork,
        }
      : {
          provide: WAGERING_UNIT_OF_WORK,
          useClass: useInMemory
            ? InMemoryWageringUnitOfWork
            : PostgresWageringUnitOfWork,
        };

    return {
      module: AppModule,
      controllers: [WalletsController, TransactionsController, HealthController],
      providers: [
        uowProvider,
        CreateWalletUseCase,
        ProcessWagerTransactionUseCase,
        QueryWageringUseCase,
        ResolvePendingReferencesUseCase,
        ReconcileWalletUseCase,
        SqsWageringMessagingService,
      ],
      exports: [
        WAGERING_UNIT_OF_WORK,
        CreateWalletUseCase,
        ProcessWagerTransactionUseCase,
        QueryWageringUseCase,
        ResolvePendingReferencesUseCase,
        ReconcileWalletUseCase,
        SqsWageringMessagingService,
      ],
    };
  }
}
