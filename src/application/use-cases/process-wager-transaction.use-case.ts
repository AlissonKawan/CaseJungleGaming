import { Inject, Injectable } from '@nestjs/common';
import { LedgerEntry } from '../../domain/ledger/ledger-entry';
import { IntegrationEventType } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-inbox';
import { Money } from '../../domain/money/money';
import {
  FailureCode,
  IdempotencyConflictError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  computeCanonicalPayloadHash,
} from '../../domain/transaction/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import {
  EntityNotFoundError,
  ExternalTransactionConflictError,
} from '../errors/application-errors';
import {
  type TransactionalWageringRepositories,
  WAGERING_UNIT_OF_WORK,
  type WageringUnitOfWorkPort,
} from '../ports/wagering-unit-of-work.port';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: {
    amount: string;
    currency: string;
  };
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  amount: string;
  currency: string;
  walletBalance: string;
  walletVersion: number;
  referenceTransactionId: string | null;
  referenceExternalTransactionId: string | null;
  ledgerEntryId: string | null;
  processedAt: string | null;
  createdAt: string;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(WAGERING_UNIT_OF_WORK)
    private readonly uow: WageringUnitOfWorkPort
  ) {}

  public async execute(
    command: ProcessWagerTransactionCommand
  ): Promise<ProcessWagerTransactionResult> {
    const money = Money.from(command.money.amount, command.money.currency);
    const idempotencyKey = command.idempotencyKey?.trim();
    const providerId = command.providerId?.trim();
    const externalTransactionId = command.externalTransactionId?.trim();
    const playerId = command.playerId?.trim();
    const walletId = command.walletId?.trim();
    const roundId = command.roundId?.trim();
    const gameId = command.gameId?.trim();
    const referenceExternalTransactionId = command.referenceExternalTransactionId?.trim();

    const payloadHash = computeCanonicalPayloadHash({
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId,
    });

    return this.uow.runInTransaction(async (repos) => {
      // 1. Checagem rapida de idempotencia antes do lock
      const preLockExisting = await repos.findTransactionByIdempotencyKey(idempotencyKey);
      if (preLockExisting) {
        return this.handleExistingIdempotentTransaction(preLockExisting, payloadHash);
      }

      // 2. Lock pessimista na linha da Wallet (SELECT ... FOR UPDATE)
      // Serializa qualquer operacao concorrente sobre a mesma carteira!
      const wallet = await repos.findWalletByIdForUpdate(walletId);
      if (!wallet) {
        throw new EntityNotFoundError('Wallet', walletId);
      }

      // 3. Re-checagem de idempotencia APOS adquirir o lock da carteira
      // (Caso duas requisicoes identicas tenham chegado no mesmo milissegundo)
      const postLockExisting = await repos.findTransactionByIdempotencyKey(idempotencyKey);
      if (postLockExisting) {
        return this.handleExistingIdempotentTransaction(postLockExisting, payloadHash);
      }

      // 4. Checagem de unicidade por (providerId, externalTransactionId)
      const existingByExternal = await repos.findTransactionByProviderAndExternalId(
        providerId,
        externalTransactionId
      );
      if (existingByExternal) {
        if (existingByExternal.payloadHash === payloadHash) {
          return this.handleExistingIdempotentTransaction(existingByExternal, payloadHash);
        }
        throw new ExternalTransactionConflictError(providerId, externalTransactionId);
      }

      const now = new Date();
      const tx = WagerTransaction.create({
        providerId,
        externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId,
        playerId,
        roundId,
        gameId,
        kind: command.kind,
        money,
        referenceExternalTransactionId,
        createdAt: now,
      });

      // 5. Validacao de identidade do jogador e moeda contra a carteira
      if (wallet.playerId !== playerId) {
        return this.rejectAndPersist(
          repos,
          tx,
          wallet,
          FailureCode.PlayerMismatch,
          now
        );
      }
      if (wallet.currency !== money.currency) {
        return this.rejectAndPersist(
          repos,
          tx,
          wallet,
          FailureCode.CurrencyMismatch,
          now
        );
      }

      // 6. Despacho por tipo de operacao financeira
      switch (tx.kind) {
        case WagerTransactionKind.Bet:
          return this.processBet(repos, tx, wallet, now);
        case WagerTransactionKind.Win:
          return this.processWin(repos, tx, wallet, now);
        case WagerTransactionKind.Loss:
          return this.processLoss(repos, tx, wallet, now);
        case WagerTransactionKind.Refund:
          return this.processRefund(repos, tx, wallet, now);
        case WagerTransactionKind.Rollback:
          return this.processRollback(repos, tx, wallet, now);
        default:
          return this.rejectAndPersist(
            repos,
            tx,
            wallet,
            FailureCode.InvalidOperation,
            now
          );
      }
    });
  }

  private handleExistingIdempotentTransaction(
    existing: WagerTransaction,
    incomingPayloadHash: string
  ): ProcessWagerTransactionResult {
    if (existing.payloadHash !== incomingPayloadHash) {
      throw new IdempotencyConflictError(existing.idempotencyKey);
    }
    if (existing.responseSnapshot) {
      return {
        ...(existing.responseSnapshot as unknown as ProcessWagerTransactionResult),
        idempotentReplay: true,
      };
    }
    return {
      transactionId: existing.id,
      providerId: existing.providerId,
      externalTransactionId: existing.externalTransactionId,
      idempotencyKey: existing.idempotencyKey,
      walletId: existing.walletId,
      playerId: existing.playerId,
      roundId: existing.roundId,
      gameId: existing.gameId,
      kind: existing.kind,
      status: existing.status,
      failureCode: existing.failureCode ?? null,
      amount: existing.money.amount,
      currency: existing.money.currency,
      walletBalance: '0.00',
      walletVersion: 1,
      referenceTransactionId: existing.referenceTransactionId ?? null,
      referenceExternalTransactionId: existing.referenceExternalTransactionId ?? null,
      ledgerEntryId: null,
      processedAt: existing.processedAt?.toISOString() ?? null,
      createdAt: existing.createdAt.toISOString(),
      idempotentReplay: true,
    };
  }

  private async processBet(
    repos: TransactionalWageringRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date
  ): Promise<ProcessWagerTransactionResult> {
    if (wallet.balance.isLessThan(tx.money)) {
      return this.rejectAndPersist(
        repos,
        tx,
        wallet,
        FailureCode.InsufficientFunds,
        now
      );
    }

    const balanceBefore = wallet.balance;
    wallet.debit(tx.money);
    const balanceAfter = wallet.balance;

    await repos.updateWallet(wallet);

    const ledgerEntry = LedgerEntry.create({
      walletId: wallet.id,
      transactionId: tx.id,
      direction: 'DEBIT',
      operationType: 'BET',
      amount: tx.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    const snapshot = this.buildSnapshot(tx, wallet, WagerTransactionStatus.Processed, null, null, ledgerEntry.id, now);
    tx.markProcessed(undefined, now, snapshot as unknown as Record<string, unknown>);

    await repos.insertTransaction(tx);
    await repos.insertLedgerEntry(ledgerEntry);
    await this.emitBalanceAndProcessedEvents(repos, tx, wallet, ledgerEntry, now);

    return snapshot;
  }

  private async processWin(
    repos: TransactionalWageringRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date
  ): Promise<ProcessWagerTransactionResult> {
    let resolvedReferenceId: string | undefined;

    if (tx.referenceExternalTransactionId) {
      const refTx = await repos.findTransactionByProviderAndExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId
      );
      if (!refTx || refTx.status === WagerTransactionStatus.Pending || refTx.status === WagerTransactionStatus.PendingReference) {
        return this.markPendingReferenceAndPersist(repos, tx, wallet, now);
      }
      if (refTx.status !== WagerTransactionStatus.Processed) {
        return this.rejectAndPersist(repos, tx, wallet, FailureCode.ReferenceNotProcessed, now);
      }
      if (refTx.kind !== WagerTransactionKind.Bet) {
        return this.rejectAndPersist(repos, tx, wallet, FailureCode.InvalidReferenceKind, now);
      }
      if (
        refTx.walletId !== tx.walletId ||
        refTx.playerId !== tx.playerId ||
        refTx.roundId !== tx.roundId ||
        refTx.gameId !== tx.gameId
      ) {
        return this.rejectAndPersist(repos, tx, wallet, FailureCode.ReferenceContextMismatch, now);
      }
      resolvedReferenceId = refTx.id;
    }

    const balanceBefore = wallet.balance;
    wallet.credit(tx.money);
    const balanceAfter = wallet.balance;

    await repos.updateWallet(wallet);

    const ledgerEntry = LedgerEntry.create({
      walletId: wallet.id,
      transactionId: tx.id,
      direction: 'CREDIT',
      operationType: 'WIN',
      amount: tx.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    const snapshot = this.buildSnapshot(
      tx,
      wallet,
      WagerTransactionStatus.Processed,
      null,
      resolvedReferenceId ?? null,
      ledgerEntry.id,
      now
    );
    tx.markProcessed(resolvedReferenceId, now, snapshot as unknown as Record<string, unknown>);

    await repos.insertTransaction(tx);
    await repos.insertLedgerEntry(ledgerEntry);
    await this.emitBalanceAndProcessedEvents(repos, tx, wallet, ledgerEntry, now);

    return snapshot;
  }

  private async processLoss(
    repos: TransactionalWageringRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date
  ): Promise<ProcessWagerTransactionResult> {
    // LOSS registra o resultado da rodada sem alterar o saldo da Wallet e sem criar LedgerEntry
    const snapshot = this.buildSnapshot(
      tx,
      wallet,
      WagerTransactionStatus.Processed,
      null,
      null,
      null,
      now
    );
    tx.markProcessed(undefined, now, snapshot as unknown as Record<string, unknown>);

    await repos.insertTransaction(tx);

    const processedOutbox = OutboxMessage.create({
      aggregateType: 'WagerTransaction',
      aggregateId: tx.id,
      eventType: IntegrationEventType.WagerTransactionProcessed,
      payload: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        status: WagerTransactionStatus.Processed,
        amount: tx.money.amount,
        currency: tx.money.currency,
        balanceAfter: wallet.balance.amount,
        processedAt: now.toISOString(),
      },
      createdAt: now,
    });
    await repos.insertOutboxMessage(processedOutbox);

    return snapshot;
  }

  private async processRefund(
    repos: TransactionalWageringRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date
  ): Promise<ProcessWagerTransactionResult> {
    const refExtId = tx.referenceExternalTransactionId!;
    const refTx = await repos.findTransactionByProviderAndExternalId(tx.providerId, refExtId);

    if (
      !refTx ||
      refTx.status === WagerTransactionStatus.Pending ||
      refTx.status === WagerTransactionStatus.PendingReference
    ) {
      return this.markPendingReferenceAndPersist(repos, tx, wallet, now);
    }

    if (refTx.status !== WagerTransactionStatus.Processed) {
      return this.rejectAndPersist(repos, tx, wallet, FailureCode.ReferenceNotProcessed, now);
    }
    if (refTx.kind !== WagerTransactionKind.Bet) {
      return this.rejectAndPersist(repos, tx, wallet, FailureCode.InvalidReferenceKind, now);
    }
    if (
      refTx.walletId !== tx.walletId ||
      refTx.playerId !== tx.playerId ||
      refTx.roundId !== tx.roundId ||
      refTx.gameId !== tx.gameId
    ) {
      return this.rejectAndPersist(repos, tx, wallet, FailureCode.ReferenceContextMismatch, now);
    }
    if (!refTx.money.equals(tx.money)) {
      return this.rejectAndPersist(repos, tx, wallet, FailureCode.ReferenceAmountMismatch, now);
    }

    const existingReversal = await repos.findProcessedReversalForReference(refTx.id);
    if (existingReversal) {
      return this.rejectAndPersist(repos, tx, wallet, FailureCode.DuplicateReversal, now);
    }

    const balanceBefore = wallet.balance;
    wallet.credit(tx.money);
    const balanceAfter = wallet.balance;

    await repos.updateWallet(wallet);

    const ledgerEntry = LedgerEntry.create({
      walletId: wallet.id,
      transactionId: tx.id,
      direction: 'CREDIT',
      operationType: 'REFUND',
      amount: tx.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    const snapshot = this.buildSnapshot(
      tx,
      wallet,
      WagerTransactionStatus.Processed,
      null,
      refTx.id,
      ledgerEntry.id,
      now
    );
    tx.markProcessed(refTx.id, now, snapshot as unknown as Record<string, unknown>);

    await repos.insertTransaction(tx);
    await repos.insertLedgerEntry(ledgerEntry);
    await this.emitBalanceAndProcessedEvents(repos, tx, wallet, ledgerEntry, now);

    return snapshot;
  }

  private async processRollback(
    repos: TransactionalWageringRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date
  ): Promise<ProcessWagerTransactionResult> {
    const refExtId = tx.referenceExternalTransactionId!;
    const refTx = await repos.findTransactionByProviderAndExternalId(tx.providerId, refExtId);

    if (
      !refTx ||
      refTx.status === WagerTransactionStatus.Pending ||
      refTx.status === WagerTransactionStatus.PendingReference
    ) {
      return this.markPendingReferenceAndPersist(repos, tx, wallet, now);
    }

    if (refTx.status !== WagerTransactionStatus.Processed) {
      return this.rejectAndPersist(repos, tx, wallet, FailureCode.ReferenceNotProcessed, now);
    }

    if (
      refTx.kind !== WagerTransactionKind.Bet &&
      refTx.kind !== WagerTransactionKind.Win &&
      refTx.kind !== WagerTransactionKind.Refund
    ) {
      return this.rejectAndPersist(repos, tx, wallet, FailureCode.InvalidReferenceKind, now);
    }

    if (
      refTx.walletId !== tx.walletId ||
      refTx.playerId !== tx.playerId ||
      refTx.roundId !== tx.roundId ||
      refTx.gameId !== tx.gameId
    ) {
      return this.rejectAndPersist(repos, tx, wallet, FailureCode.ReferenceContextMismatch, now);
    }

    if (!refTx.money.equals(tx.money)) {
      return this.rejectAndPersist(repos, tx, wallet, FailureCode.ReferenceAmountMismatch, now);
    }

    const existingReversal = await repos.findProcessedReversalForReference(refTx.id);
    if (existingReversal) {
      return this.rejectAndPersist(repos, tx, wallet, FailureCode.DuplicateReversal, now);
    }

    const direction = refTx.kind === WagerTransactionKind.Bet ? 'CREDIT' : 'DEBIT';

    if (direction === 'DEBIT' && wallet.balance.isLessThan(tx.money)) {
      // Regra 7.9: Falta de saldo em estorno usa REVERSAL_INSUFFICIENT_FUNDS (distinto de INSUFFICIENT_FUNDS)
      return this.rejectAndPersist(
        repos,
        tx,
        wallet,
        FailureCode.ReversalInsufficientFunds,
        now
      );
    }

    const balanceBefore = wallet.balance;
    if (direction === 'CREDIT') {
      wallet.credit(tx.money);
    } else {
      wallet.debit(tx.money);
    }
    const balanceAfter = wallet.balance;

    await repos.updateWallet(wallet);

    const ledgerEntry = LedgerEntry.create({
      walletId: wallet.id,
      transactionId: tx.id,
      direction,
      operationType: 'ROLLBACK',
      amount: tx.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    const snapshot = this.buildSnapshot(
      tx,
      wallet,
      WagerTransactionStatus.Processed,
      null,
      refTx.id,
      ledgerEntry.id,
      now
    );
    tx.markProcessed(refTx.id, now, snapshot as unknown as Record<string, unknown>);

    await repos.insertTransaction(tx);
    await repos.insertLedgerEntry(ledgerEntry);
    await this.emitBalanceAndProcessedEvents(repos, tx, wallet, ledgerEntry, now);

    return snapshot;
  }

  private async markPendingReferenceAndPersist(
    repos: TransactionalWageringRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    now: Date
  ): Promise<ProcessWagerTransactionResult> {
    tx.markPendingReference();
    const snapshot = this.buildSnapshot(
      tx,
      wallet,
      WagerTransactionStatus.PendingReference,
      null,
      null,
      null,
      null
    );
    tx.attachResponseSnapshot(snapshot as unknown as Record<string, unknown>);

    await repos.insertTransaction(tx);

    const outboxMsg = OutboxMessage.create({
      aggregateType: 'WagerTransaction',
      aggregateId: tx.id,
      eventType: IntegrationEventType.WagerTransactionPendingReference,
      payload: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        referenceExternalTransactionId: tx.referenceExternalTransactionId ?? '',
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: tx.kind,
        amount: tx.money.amount,
        currency: tx.money.currency,
        recordedAt: now.toISOString(),
      },
      createdAt: now,
    });
    await repos.insertOutboxMessage(outboxMsg);

    return snapshot;
  }

  private async rejectAndPersist(
    repos: TransactionalWageringRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    failureCode: FailureCode,
    now: Date
  ): Promise<ProcessWagerTransactionResult> {
    const snapshot = this.buildSnapshot(
      tx,
      wallet,
      WagerTransactionStatus.Rejected,
      failureCode,
      null,
      null,
      now
    );
    tx.reject(failureCode, now, snapshot as unknown as Record<string, unknown>);

    await repos.insertTransaction(tx);

    const outboxMsg = OutboxMessage.create({
      aggregateType: 'WagerTransaction',
      aggregateId: tx.id,
      eventType: IntegrationEventType.WagerTransactionRejected,
      payload: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        status: WagerTransactionStatus.Rejected,
        failureCode,
        amount: tx.money.amount,
        currency: tx.money.currency,
        rejectedAt: now.toISOString(),
      },
      createdAt: now,
    });
    await repos.insertOutboxMessage(outboxMsg);

    return snapshot;
  }

  private async emitBalanceAndProcessedEvents(
    repos: TransactionalWageringRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    ledgerEntry: LedgerEntry,
    now: Date
  ): Promise<void> {
    const balanceOutbox = OutboxMessage.create({
      aggregateType: 'Wallet',
      aggregateId: wallet.id,
      eventType: IntegrationEventType.WalletBalanceChanged,
      payload: {
        walletId: wallet.id,
        playerId: wallet.playerId,
        transactionId: tx.id,
        ledgerEntryId: ledgerEntry.id,
        direction: ledgerEntry.direction,
        operationType: ledgerEntry.operationType,
        amount: ledgerEntry.amount.amount,
        currency: ledgerEntry.amount.currency,
        balanceBefore: ledgerEntry.balanceBefore.amount,
        balanceAfter: ledgerEntry.balanceAfter.amount,
        walletVersion: wallet.version,
        occurredAt: now.toISOString(),
      },
      createdAt: now,
    });

    const processedOutbox = OutboxMessage.create({
      aggregateType: 'WagerTransaction',
      aggregateId: tx.id,
      eventType: IntegrationEventType.WagerTransactionProcessed,
      payload: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        status: WagerTransactionStatus.Processed,
        amount: tx.money.amount,
        currency: tx.money.currency,
        balanceAfter: wallet.balance.amount,
        processedAt: now.toISOString(),
      },
      createdAt: now,
    });

    await repos.insertOutboxMessage(balanceOutbox);
    await repos.insertOutboxMessage(processedOutbox);
  }

  private buildSnapshot(
    tx: WagerTransaction,
    wallet: Wallet,
    status: WagerTransactionStatus,
    failureCode: FailureCode | null,
    referenceTransactionId: string | null,
    ledgerEntryId: string | null,
    processedAt: Date | null
  ): ProcessWagerTransactionResult {
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      status,
      failureCode,
      amount: tx.money.amount,
      currency: tx.money.currency,
      walletBalance: wallet.balance.amount,
      walletVersion: wallet.version,
      referenceTransactionId,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      ledgerEntryId,
      processedAt: processedAt ? processedAt.toISOString() : null,
      createdAt: tx.createdAt.toISOString(),
      idempotentReplay: false,
    };
  }
}
