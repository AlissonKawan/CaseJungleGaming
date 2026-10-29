import { Inject, Injectable } from '@nestjs/common';
import { LedgerEntry } from '../../domain/ledger/ledger-entry';
import { IntegrationEventType } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-inbox';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/transaction/wager-transaction';
import { EntityNotFoundError } from '../errors/application-errors';
import {
  WAGERING_UNIT_OF_WORK,
  type WageringUnitOfWorkPort,
} from '../ports/wagering-unit-of-work.port';
import type { ProcessWagerTransactionResult } from './process-wager-transaction.use-case';

@Injectable()
export class QueryWageringUseCase {
  constructor(
    @Inject(WAGERING_UNIT_OF_WORK)
    private readonly uow: WageringUnitOfWorkPort
  ) {}

  public async getWallet(walletId: string) {
    return this.uow.runInTransaction(async (repos) => {
      const wallet = await repos.findWalletById(walletId);
      if (!wallet) {
        throw new EntityNotFoundError('Wallet', walletId);
      }
      return {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.amount,
        version: wallet.version,
        createdAt: wallet.createdAt.toISOString(),
        updatedAt: wallet.updatedAt.toISOString(),
      };
    });
  }

  public async listWalletLedger(walletId: string, limit: number = 50, cursor?: string) {
    const safeLimit = Math.min(Math.max(1, limit || 50), 100);
    return this.uow.runInTransaction(async (repos) => {
      const wallet = await repos.findWalletById(walletId);
      if (!wallet) {
        throw new EntityNotFoundError('Wallet', walletId);
      }
      const page = await repos.listLedgerEntriesByWallet(wallet.id, safeLimit, cursor);
      return {
        walletId: wallet.id,
        items: page.items.map((entry) => ({
          ledgerEntryId: entry.id,
          walletId: entry.walletId,
          transactionId: entry.transactionId,
          direction: entry.direction,
          operationType: entry.operationType,
          amount: entry.amount.amount,
          currency: entry.amount.currency,
          balanceBefore: entry.balanceBefore.amount,
          balanceAfter: entry.balanceAfter.amount,
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    });
  }

  public async getTransactionById(transactionId: string) {
    return this.uow.runInTransaction(async (repos) => {
      const tx = await repos.findTransactionById(transactionId);
      if (!tx) {
        throw new EntityNotFoundError('WagerTransaction', transactionId);
      }
      return this.mapTransaction(tx);
    });
  }

  public async getTransactionByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string
  ) {
    return this.uow.runInTransaction(async (repos) => {
      const tx = await repos.findTransactionByProviderAndExternalId(
        providerId,
        externalTransactionId
      );
      if (!tx) {
        throw new EntityNotFoundError(
          'WagerTransaction',
          `${providerId}:${externalTransactionId}`
        );
      }
      return this.mapTransaction(tx);
    });
  }

  private mapTransaction(tx: WagerTransaction) {
    if (tx.responseSnapshot) {
      return {
        ...tx.responseSnapshot,
        status: tx.status,
        failureCode: tx.failureCode ?? null,
      };
    }
    return {
      transactionId: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      amount: tx.money.amount,
      currency: tx.money.currency,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      processedAt: tx.processedAt?.toISOString() ?? null,
      createdAt: tx.createdAt.toISOString(),
    };
  }
}

@Injectable()
export class ResolvePendingReferencesUseCase {
  constructor(
    @Inject(WAGERING_UNIT_OF_WORK)
    private readonly uow: WageringUnitOfWorkPort
  ) {}

  /**
   * Reprocessa transacoes em estado PENDING_REFERENCE.
   * Se a transacao referenciada ja chegou e foi PROCESSED, aplica o efeito financeiro.
   * Se o TTL (maxAgeMs) expirou sem a referencia aparecer, rejeita com REFERENCE_NOT_FOUND.
   */
  public async execute(
    options: { limit?: number; maxAgeMs?: number; now?: Date } = {}
  ): Promise<{ resolved: number; rejected: number; stillPending: number }> {
    const limit = options.limit ?? 50;
    const maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;
    const now = options.now ?? new Date();

    return this.uow.runInTransaction(async (repos) => {
      const pendingList = await repos.findPendingReferenceTransactions(limit);
      let resolved = 0;
      let rejected = 0;
      let stillPending = 0;

      for (const tx of pendingList) {
        const wallet = await repos.findWalletByIdForUpdate(tx.walletId);
        if (!wallet) {
          continue;
        }

        const refExtId = tx.referenceExternalTransactionId;
        const refTx = refExtId
          ? await repos.findTransactionByProviderAndExternalId(tx.providerId, refExtId)
          : null;

        if (
          !refTx ||
          refTx.status === WagerTransactionStatus.Pending ||
          refTx.status === WagerTransactionStatus.PendingReference
        ) {
          const ageMs = now.getTime() - tx.createdAt.getTime();
          if (ageMs >= maxAgeMs) {
            const snapshot: ProcessWagerTransactionResult = {
              transactionId: tx.id,
              providerId: tx.providerId,
              externalTransactionId: tx.externalTransactionId,
              idempotencyKey: tx.idempotencyKey,
              walletId: wallet.id,
              playerId: wallet.playerId,
              roundId: tx.roundId,
              gameId: tx.gameId,
              kind: tx.kind,
              status: WagerTransactionStatus.Rejected,
              failureCode: FailureCode.ReferenceNotFound,
              amount: tx.money.amount,
              currency: tx.money.currency,
              walletBalance: wallet.balance.amount,
              walletVersion: wallet.version,
              referenceTransactionId: null,
              referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
              ledgerEntryId: null,
              processedAt: now.toISOString(),
              createdAt: tx.createdAt.toISOString(),
              idempotentReplay: false,
            };
            tx.reject(
              FailureCode.ReferenceNotFound,
              now,
              snapshot as unknown as Record<string, unknown>
            );
            await repos.updateTransaction(tx);
            await repos.insertOutboxMessage(
              OutboxMessage.create({
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
                  failureCode: FailureCode.ReferenceNotFound,
                  amount: tx.money.amount,
                  currency: tx.money.currency,
                  rejectedAt: now.toISOString(),
                },
                createdAt: now,
              })
            );
            rejected += 1;
          } else {
            stillPending += 1;
          }
          continue;
        }

        if (refTx.status !== WagerTransactionStatus.Processed) {
          tx.reject(FailureCode.ReferenceNotProcessed, now);
          await repos.updateTransaction(tx);
          rejected += 1;
          continue;
        }

        const existingReversal = await repos.findProcessedReversalForReference(refTx.id);
        if (existingReversal && tx.kind !== WagerTransactionKind.Win) {
          tx.reject(FailureCode.DuplicateReversal, now);
          await repos.updateTransaction(tx);
          rejected += 1;
          continue;
        }

        const direction =
          tx.kind === WagerTransactionKind.Refund ||
          tx.kind === WagerTransactionKind.Win ||
          refTx.kind === WagerTransactionKind.Bet
            ? 'CREDIT'
            : 'DEBIT';

        if (direction === 'DEBIT' && wallet.balance.isLessThan(tx.money)) {
          tx.reject(FailureCode.ReversalInsufficientFunds, now);
          await repos.updateTransaction(tx);
          rejected += 1;
          continue;
        }

        const balanceBefore = wallet.balance;
        if (direction === 'CREDIT') {
          wallet.credit(tx.money);
        } else {
          wallet.debit(tx.money);
        }
        const balanceAfter = wallet.balance;
        await repos.updateWallet(wallet);

        const opType =
          tx.kind === WagerTransactionKind.Refund
            ? 'REFUND'
            : tx.kind === WagerTransactionKind.Win
              ? 'WIN'
              : 'ROLLBACK';

        const ledgerEntry = LedgerEntry.create({
          walletId: wallet.id,
          transactionId: tx.id,
          direction,
          operationType: opType,
          amount: tx.money,
          balanceBefore,
          balanceAfter,
          createdAt: now,
        });

        const snapshot: ProcessWagerTransactionResult = {
          transactionId: tx.id,
          providerId: tx.providerId,
          externalTransactionId: tx.externalTransactionId,
          idempotencyKey: tx.idempotencyKey,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: tx.roundId,
          gameId: tx.gameId,
          kind: tx.kind,
          status: WagerTransactionStatus.Processed,
          failureCode: null,
          amount: tx.money.amount,
          currency: tx.money.currency,
          walletBalance: wallet.balance.amount,
          walletVersion: wallet.version,
          referenceTransactionId: refTx.id,
          referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
          ledgerEntryId: ledgerEntry.id,
          processedAt: now.toISOString(),
          createdAt: tx.createdAt.toISOString(),
          idempotentReplay: false,
        };

        tx.markProcessed(refTx.id, now, snapshot as unknown as Record<string, unknown>);
        await repos.updateTransaction(tx);
        await repos.insertLedgerEntry(ledgerEntry);
        await repos.insertOutboxMessage(
          OutboxMessage.create({
            aggregateType: 'Wallet',
            aggregateId: wallet.id,
            eventType: IntegrationEventType.WalletBalanceChanged,
            payload: {
              walletId: wallet.id,
              playerId: wallet.playerId,
              transactionId: tx.id,
              ledgerEntryId: ledgerEntry.id,
              direction,
              operationType: opType,
              amount: tx.money.amount,
              currency: tx.money.currency,
              balanceBefore: balanceBefore.amount,
              balanceAfter: balanceAfter.amount,
              walletVersion: wallet.version,
              occurredAt: now.toISOString(),
            },
            createdAt: now,
          })
        );
        await repos.insertOutboxMessage(
          OutboxMessage.create({
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
          })
        );
        resolved += 1;
      }

      return { resolved, rejected, stillPending };
    });
  }
}
