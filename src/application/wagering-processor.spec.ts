import 'reflect-metadata';
import { beforeEach, describe, expect, it } from 'bun:test';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';
import {
  FailureCode,
  IdempotencyConflictError,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/transaction/wager-transaction';
import { InMemoryWageringUnitOfWork } from '../infrastructure/database/in-memory-unit-of-work';
import { SqsWageringMessagingService } from '../infrastructure/messaging/sqs-wagering.service';
import { TransactionsController } from '../presentation/controllers/transactions.controller';
import { WalletsController } from '../presentation/controllers/wallets.controller';

describe('Distributed Wagering Processor — NestJS Application & Financial Invariants', () => {
  let moduleRef: TestingModule;
  let walletsController: WalletsController;
  let transactionsController: TransactionsController;
  let sqsService: SqsWageringMessagingService;
  let uow: InMemoryWageringUnitOfWork;

  beforeEach(async () => {
    process.env.SQS_ENABLED = 'false';
    uow = new InMemoryWageringUnitOfWork();

    moduleRef = await Test.createTestingModule({
      imports: [AppModule.register({ unitOfWork: uow })],
    }).compile();

    walletsController = moduleRef.get<WalletsController>(WalletsController);
    transactionsController = moduleRef.get<TransactionsController>(TransactionsController);
    sqsService = moduleRef.get<SqsWageringMessagingService>(SqsWageringMessagingService);
  });

  it('1. Wallet Opening: should create wallet with 100.00 BRL, OPENING ledger entry, and reconcile as CONSISTENT', async () => {
    const wallet = await walletsController.createWallet({
      playerId: 'player-01',
      currency: 'BRL',
      initialBalance: '100.00',
      idempotencyKey: 'open-wallet-01',
    });

    expect(wallet.balance).toBe('100.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.idempotentReplay).toBe(false);

    const ledger = await walletsController.listWalletLedger(wallet.walletId);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]?.operationType).toBe('OPENING');
    expect(ledger.items[0]?.direction).toBe('CREDIT');
    expect(ledger.items[0]?.balanceBefore).toBe('0.00');
    expect(ledger.items[0]?.balanceAfter).toBe('100.00');

    const recon = await walletsController.reconcileWallet(wallet.walletId);
    expect(recon.status).toBe('CONSISTENT');
    expect(recon.walletBalance).toBe('100.00');
    expect(recon.ledgerDerivedBalance).toBe('100.00');
    expect(recon.discrepancyAmount).toBe('0.00');
  });

  it('2. Eliminatory Concurrency Invariant: two simultaneous 80.00 BRL BETs on 100.00 BRL balance must allow exactly ONE and reject the other with INSUFFICIENT_FUNDS (final balance 20.00 BRL)', async () => {
    const wallet = await walletsController.createWallet({
      playerId: 'player-concurrency',
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const [betA, betB] = await Promise.all([
      transactionsController.processTransaction({
        idempotencyKey: 'conc-bet-1',
        providerId: 'pragmatic',
        externalTransactionId: 'ext-bet-1',
        playerId: 'player-concurrency',
        walletId: wallet.walletId,
        roundId: 'round-1',
        gameId: 'gates-of-olympus',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      }),
      transactionsController.processTransaction({
        idempotencyKey: 'conc-bet-2',
        providerId: 'pragmatic',
        externalTransactionId: 'ext-bet-2',
        playerId: 'player-concurrency',
        walletId: wallet.walletId,
        roundId: 'round-1',
        gameId: 'gates-of-olympus',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      }),
    ]);

    const statuses = [betA.status, betB.status].sort();
    expect(statuses).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);

    const rejected = betA.status === WagerTransactionStatus.Rejected ? betA : betB;
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    const updatedWallet = await walletsController.getWallet(wallet.walletId);
    expect(updatedWallet.balance).toBe('20.00');

    const recon = await walletsController.reconcileWallet(wallet.walletId);
    expect(recon.status).toBe('CONSISTENT');
    expect(recon.walletBalance).toBe('20.00');
    expect(recon.ledgerDerivedBalance).toBe('20.00');
    expect(recon.entryCount).toBe(2); // OPENING (100) + 1 BET (80)
  });

  it('3. Strict Idempotency: same idempotencyKey + same payload returns snapshot without double debit; same key + different payload throws IdempotencyConflictError (409)', async () => {
    const wallet = await walletsController.createWallet({
      playerId: 'player-idemp',
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const command = {
      idempotencyKey: 'idemp-key-01',
      providerId: 'evolution',
      externalTransactionId: 'ext-idemp-01',
      playerId: 'player-idemp',
      walletId: wallet.walletId,
      roundId: 'round-10',
      gameId: 'crazy-time',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    };

    const firstCall = await transactionsController.processTransaction(command);
    expect(firstCall.status).toBe(WagerTransactionStatus.Processed);
    expect(firstCall.walletBalance).toBe('70.00');
    expect(firstCall.idempotentReplay).toBe(false);

    const secondCall = await transactionsController.processTransaction(command);
    expect(secondCall.transactionId).toBe(firstCall.transactionId);
    expect(secondCall.walletBalance).toBe('70.00');
    expect(secondCall.idempotentReplay).toBe(true);

    // Mesma chave com valor alterado (30.00 -> 50.00) deve disparar conflito!
    await expect(
      transactionsController.processTransaction({
        ...command,
        money: { amount: '50.00', currency: 'BRL' },
      })
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('4. Full Wager Lifecycle: BET -> LOSS (no ledger entry) -> WIN -> ROLLBACK of WIN (including REVERSAL_INSUFFICIENT_FUNDS check)', async () => {
    const wallet = await walletsController.createWallet({
      playerId: 'player-lifecycle',
      currency: 'BRL',
      initialBalance: '50.00',
    });

    // 1. BET 20.00 -> Saldo 30.00
    const bet = await transactionsController.processTransaction({
      idempotencyKey: 'lc-bet-1',
      providerId: 'pragmatic',
      externalTransactionId: 'ext-lc-bet-1',
      playerId: 'player-lifecycle',
      walletId: wallet.walletId,
      roundId: 'round-lc',
      gameId: 'sweet-bonanza',
      kind: WagerTransactionKind.Bet,
      money: { amount: '20.00', currency: 'BRL' },
    });
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.walletBalance).toBe('30.00');

    // 2. LOSS 0.00 referenciando o BET -> Nao altera saldo nem cria LedgerEntry
    const loss = await transactionsController.processTransaction({
      idempotencyKey: 'lc-loss-1',
      providerId: 'pragmatic',
      externalTransactionId: 'ext-lc-loss-1',
      playerId: 'player-lifecycle',
      walletId: wallet.walletId,
      roundId: 'round-lc',
      gameId: 'sweet-bonanza',
      kind: WagerTransactionKind.Loss,
      money: { amount: '0.00', currency: 'BRL' },
      referenceExternalTransactionId: 'ext-lc-bet-1',
    });
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.ledgerEntryId).toBeNull();
    expect(loss.walletBalance).toBe('30.00');

    // 3. WIN 40.00 -> Saldo 70.00
    const win = await transactionsController.processTransaction({
      idempotencyKey: 'lc-win-1',
      providerId: 'pragmatic',
      externalTransactionId: 'ext-lc-win-1',
      playerId: 'player-lifecycle',
      walletId: wallet.walletId,
      roundId: 'round-lc',
      gameId: 'sweet-bonanza',
      kind: WagerTransactionKind.Win,
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: 'ext-lc-bet-1',
    });
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.walletBalance).toBe('70.00');

    // 4. Jogador faz outra aposta de 50.00 -> Saldo cai para 20.00
    await transactionsController.processTransaction({
      idempotencyKey: 'lc-bet-2',
      providerId: 'pragmatic',
      externalTransactionId: 'ext-lc-bet-2',
      playerId: 'player-lifecycle',
      walletId: wallet.walletId,
      roundId: 'round-lc-2',
      gameId: 'sweet-bonanza',
      kind: WagerTransactionKind.Bet,
      money: { amount: '50.00', currency: 'BRL' },
    });

    // 5. Tentativa de ROLLBACK do WIN de 40.00 quando o saldo e apenas 20.00
    // Deve rejeitar com REVERSAL_INSUFFICIENT_FUNDS (nunca permitir saldo negativo!)
    const failedRollback = await transactionsController.processTransaction({
      idempotencyKey: 'lc-rb-win-fail',
      providerId: 'pragmatic',
      externalTransactionId: 'ext-lc-rb-win-fail',
      playerId: 'player-lifecycle',
      walletId: wallet.walletId,
      roundId: 'round-lc',
      gameId: 'sweet-bonanza',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: 'ext-lc-win-1',
    });
    expect(failedRollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(failedRollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(failedRollback.walletBalance).toBe('20.00');

    const recon = await walletsController.reconcileWallet(wallet.walletId);
    expect(recon.status).toBe('CONSISTENT');
    expect(recon.walletBalance).toBe('20.00');
  });

  it('5. Out-of-order Delivery: REFUND arriving before BET enters PENDING_REFERENCE and resolves once BET is processed', async () => {
    const wallet = await walletsController.createWallet({
      playerId: 'player-ooo',
      currency: 'BRL',
      initialBalance: '100.00',
    });

    // 1. REFUND chega ANTES do BET existir!
    const earlyRefund = await transactionsController.processTransaction({
      idempotencyKey: 'ooo-refund-1',
      providerId: 'hacksaw',
      externalTransactionId: 'ext-ooo-refund-1',
      playerId: 'player-ooo',
      walletId: wallet.walletId,
      roundId: 'round-ooo',
      gameId: 'wanted',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'ext-ooo-bet-1',
    });
    expect(earlyRefund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(earlyRefund.walletBalance).toBe('100.00');

    // 2. Agora o BET atrasado chega e debita 25.00 -> Saldo 75.00
    const lateBet = await transactionsController.processTransaction({
      idempotencyKey: 'ooo-bet-1',
      providerId: 'hacksaw',
      externalTransactionId: 'ext-ooo-bet-1',
      playerId: 'player-ooo',
      walletId: wallet.walletId,
      roundId: 'round-ooo',
      gameId: 'wanted',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(lateBet.status).toBe(WagerTransactionStatus.Processed);
    expect(lateBet.walletBalance).toBe('75.00');

    // 3. O worker de resolucao de pendencias roda e aplica o REFUND -> Saldo volta para 100.00!
    const resolution = await transactionsController.resolvePendingReferences();
    expect(resolution.resolved).toBe(1);

    const updatedWallet = await walletsController.getWallet(wallet.walletId);
    expect(updatedWallet.balance).toBe('100.00');

    const refundAfter = await transactionsController.getTransactionById(earlyRefund.transactionId);
    expect(refundAfter.status).toBe(WagerTransactionStatus.Processed);
  });

  it('6. Transactional Inbox & Outbox Publisher: should deduplicate redelivered SQS messages and publish outbox events', async () => {
    const wallet = await walletsController.createWallet({
      playerId: 'player-sqs',
      currency: 'BRL',
      initialBalance: '100.00',
    });

    const msgCommand = {
      idempotencyKey: 'sqs-bet-01',
      providerId: 'nolimit',
      externalTransactionId: 'ext-sqs-bet-01',
      playerId: 'player-sqs',
      walletId: wallet.walletId,
      roundId: 'round-sqs',
      gameId: 'mental',
      kind: WagerTransactionKind.Bet,
      money: { amount: '15.00', currency: 'BRL' },
    };

    const firstDelivery = await sqsService.handleIncomingQueueMessage('sqs-msg-id-999', msgCommand);
    expect(firstDelivery.deduplicated).toBe(false);

    // Redelivery da mesma mensagem pelo SQS (mesmo sqs-msg-id-999)
    const redelivery = await sqsService.handleIncomingQueueMessage('sqs-msg-id-999', msgCommand);
    expect(redelivery.deduplicated).toBe(true);

    const updatedWallet = await walletsController.getWallet(wallet.walletId);
    expect(updatedWallet.balance).toBe('85.00');

    // Publica eventos pendentes do Outbox
    const publishResult = await sqsService.publishPendingOutboxBatch(50);
    expect(publishResult.published).toBeGreaterThanOrEqual(3); // 1 do opening + 2 do bet
    expect(publishResult.failed).toBe(0);
  });
});
