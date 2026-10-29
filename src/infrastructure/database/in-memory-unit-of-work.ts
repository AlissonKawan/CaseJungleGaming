import { Injectable } from '@nestjs/common';
import {
  DuplicateWalletError,
  ExternalTransactionConflictError,
} from '../../application/errors/application-errors';
import type {
  LedgerPageResult,
  LedgerTotals,
  TransactionalWageringRepositories,
  WageringUnitOfWorkPort,
} from '../../application/ports/wagering-unit-of-work.port';
import { LedgerEntry } from '../../domain/ledger/ledger-entry';
import {
  InboxMessage,
  OutboxMessage,
  OutboxMessageStatus,
} from '../../domain/messaging/outbox-inbox';
import { Money } from '../../domain/money/money';
import {
  IdempotencyConflictError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/transaction/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';

/**
 * Implementacao Transacional em Memoria da Unit of Work com Lock por WalletId.
 * Simula fielmente o SELECT ... FOR UPDATE do PostgreSQL usando filas de Promises por carteira,
 * permitindo testar cenarios de concorrencia extrema (ex: 2 apostas de 80 em saldo de 100)
 * mesmo em testes unitarios ou sem container ativo.
 */
@Injectable()
export class InMemoryWageringUnitOfWork implements WageringUnitOfWorkPort {
  private readonly wallets = new Map<string, Wallet>();
  private readonly transactions = new Map<string, WagerTransaction>();
  private readonly ledgerEntries: LedgerEntry[] = [];
  private readonly inboxMessages = new Map<string, InboxMessage>();
  private readonly outboxMessages = new Map<string, OutboxMessage>();
  private readonly walletLocks = new Map<string, Promise<void>>();
  private globalOutboxLock: Promise<void> = Promise.resolve();

  public async ping(): Promise<boolean> {
    return true;
  }

  public async runInTransaction<T>(
    work: (repos: TransactionalWageringRepositories) => Promise<T>
  ): Promise<T> {
    const heldWalletReleases: Array<() => void> = [];
    const lockedWalletIds = new Set<string>();

    const acquireWalletLock = async (walletId: string): Promise<void> => {
      if (lockedWalletIds.has(walletId)) {
        return;
      }
      while (this.walletLocks.has(walletId)) {
        await this.walletLocks.get(walletId);
      }
      let release!: () => void;
      const lockPromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.walletLocks.set(walletId, lockPromise);
      lockedWalletIds.add(walletId);
      heldWalletReleases.push(() => {
        if (this.walletLocks.get(walletId) === lockPromise) {
          this.walletLocks.delete(walletId);
        }
        release();
      });
    };

    // Snapshots para rollback em caso de excecao na transacao
    const stagedWallets = new Map<string, Wallet>();
    const stagedTransactions = new Map<string, WagerTransaction>();
    const stagedLedgerEntries: LedgerEntry[] = [];
    const stagedInbox = new Map<string, InboxMessage>();
    const stagedOutbox = new Map<string, OutboxMessage>();

    const cloneWallet = (w: Wallet): Wallet =>
      Wallet.restore({
        id: w.id,
        playerId: w.playerId,
        currency: w.currency,
        balance: w.balance,
        version: w.version,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      });

    const cloneTx = (tx: WagerTransaction): WagerTransaction =>
      WagerTransaction.rehydrate({
        id: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        idempotencyKey: tx.idempotencyKey,
        payloadHash: tx.payloadHash,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        createdAt: tx.createdAt,
        status: tx.status,
        referenceTransactionId: tx.referenceTransactionId,
        failureCode: tx.failureCode,
        processedAt: tx.processedAt,
        responseSnapshot: tx.responseSnapshot,
      });

    const allWallets = (): Wallet[] => {
      const merged = new Map<string, Wallet>(this.wallets);
      for (const [k, v] of stagedWallets) {
        merged.set(k, v);
      }
      return Array.from(merged.values());
    };

    const allTransactions = (): WagerTransaction[] => {
      const merged = new Map<string, WagerTransaction>(this.transactions);
      for (const [k, v] of stagedTransactions) {
        merged.set(k, v);
      }
      return Array.from(merged.values());
    };

    const repos: TransactionalWageringRepositories = {
      findWalletById: async (walletId: string) => {
        const w = stagedWallets.get(walletId) ?? this.wallets.get(walletId);
        return w ? cloneWallet(w) : null;
      },

      findWalletByIdForUpdate: async (walletId: string) => {
        await acquireWalletLock(walletId);
        const w = stagedWallets.get(walletId) ?? this.wallets.get(walletId);
        return w ? cloneWallet(w) : null;
      },

      findWalletByPlayerAndCurrency: async (playerId: string, currency: string) => {
        const found = allWallets().find(
          (w) => w.playerId === playerId && w.currency === currency.toUpperCase()
        );
        return found ? cloneWallet(found) : null;
      },

      insertWallet: async (wallet: Wallet) => {
        await acquireWalletLock(wallet.id);
        const dup = allWallets().find(
          (w) => w.playerId === wallet.playerId && w.currency === wallet.currency
        );
        if (dup) {
          throw new DuplicateWalletError(wallet.playerId, wallet.currency);
        }
        stagedWallets.set(wallet.id, cloneWallet(wallet));
      },

      updateWallet: async (wallet: Wallet) => {
        stagedWallets.set(wallet.id, cloneWallet(wallet));
      },

      findTransactionById: async (transactionId: string) => {
        const tx = stagedTransactions.get(transactionId) ?? this.transactions.get(transactionId);
        return tx ? cloneTx(tx) : null;
      },

      findTransactionByIdempotencyKey: async (idempotencyKey: string) => {
        const found = allTransactions().find((t) => t.idempotencyKey === idempotencyKey);
        return found ? cloneTx(found) : null;
      },

      findTransactionByProviderAndExternalId: async (
        providerId: string,
        externalTransactionId: string
      ) => {
        const found = allTransactions().find(
          (t) =>
            t.providerId === providerId && t.externalTransactionId === externalTransactionId
        );
        return found ? cloneTx(found) : null;
      },

      findProcessedReversalForReference: async (referenceTransactionId: string) => {
        const found = allTransactions().find(
          (t) =>
            t.referenceTransactionId === referenceTransactionId &&
            t.status === WagerTransactionStatus.Processed &&
            (t.kind === WagerTransactionKind.Refund || t.kind === WagerTransactionKind.Rollback)
        );
        return found ? cloneTx(found) : null;
      },

      findPendingReferenceTransactions: async (limit: number) => {
        return allTransactions()
          .filter((t) => t.status === WagerTransactionStatus.PendingReference)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map(cloneTx);
      },

      insertTransaction: async (transaction: WagerTransaction) => {
        const dupKey = allTransactions().find(
          (t) => t.idempotencyKey === transaction.idempotencyKey && t.id !== transaction.id
        );
        if (dupKey) {
          throw new IdempotencyConflictError(transaction.idempotencyKey);
        }
        const dupExt = allTransactions().find(
          (t) =>
            t.providerId === transaction.providerId &&
            t.externalTransactionId === transaction.externalTransactionId &&
            t.id !== transaction.id
        );
        if (dupExt) {
          throw new ExternalTransactionConflictError(
            transaction.providerId,
            transaction.externalTransactionId
          );
        }
        stagedTransactions.set(transaction.id, cloneTx(transaction));
      },

      updateTransaction: async (transaction: WagerTransaction) => {
        stagedTransactions.set(transaction.id, cloneTx(transaction));
      },

      insertLedgerEntry: async (entry: LedgerEntry) => {
        stagedLedgerEntries.push(entry);
      },

      listLedgerEntriesByWallet: async (
        walletId: string,
        limit: number,
        cursor?: string
      ): Promise<LedgerPageResult> => {
        const all = [...this.ledgerEntries, ...stagedLedgerEntries]
          .filter((e) => e.walletId === walletId)
          .sort((a, b) => {
            const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
            return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id);
          });

        let startIndex = 0;
        if (cursor) {
          const decodedId = Buffer.from(cursor, 'base64url').toString('utf8');
          const idx = all.findIndex((e) => e.id === decodedId);
          if (idx >= 0) {
            startIndex = idx + 1;
          }
        }

        const slice = all.slice(startIndex, startIndex + limit);
        const hasMore = startIndex + limit < all.length;
        const lastItem = slice[slice.length - 1];
        const nextCursor =
          hasMore && lastItem ? Buffer.from(lastItem.id, 'utf8').toString('base64url') : null;

        return { items: slice, nextCursor };
      },

      computeLedgerTotals: async (walletId: string, currency: string): Promise<LedgerTotals> => {
        const entries = [...this.ledgerEntries, ...stagedLedgerEntries].filter(
          (e) => e.walletId === walletId
        );
        let totalCredits = Money.zero(currency);
        let totalDebits = Money.zero(currency);

        for (const entry of entries) {
          if (entry.direction === 'CREDIT') {
            totalCredits = totalCredits.plus(entry.amount);
          } else {
            totalDebits = totalDebits.plus(entry.amount);
          }
        }

        return {
          totalCredits,
          totalDebits,
          entryCount: entries.length,
        };
      },

      findInboxMessage: async (consumerName: string, messageId: string) => {
        const key = `${consumerName}:${messageId}`;
        return stagedInbox.get(key) ?? this.inboxMessages.get(key) ?? null;
      },

      insertInboxMessage: async (message: InboxMessage) => {
        const key = `${message.consumerName}:${message.messageId}`;
        stagedInbox.set(key, message);
      },

      insertOutboxMessage: async (message: OutboxMessage) => {
        stagedOutbox.set(message.id, message);
      },

      claimPendingOutboxMessages: async (limit: number, now: Date = new Date()) => {
        const prevLock = this.globalOutboxLock;
        let releaseOutbox!: () => void;
        this.globalOutboxLock = new Promise<void>((r) => {
          releaseOutbox = r;
        });
        await prevLock;
        try {
          const all = Array.from(this.outboxMessages.values())
            .filter(
              (m) =>
                m.status === OutboxMessageStatus.Pending &&
                m.nextAttemptAt.getTime() <= now.getTime()
            )
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, limit);
          return all;
        } finally {
          releaseOutbox();
        }
      },

      updateOutboxMessage: async (message: OutboxMessage) => {
        stagedOutbox.set(message.id, message);
      },

      countPendingOutboxMessages: async () => {
        return Array.from(this.outboxMessages.values()).filter(
          (m) => m.status === OutboxMessageStatus.Pending
        ).length;
      },
    };

    try {
      const result = await work(repos);
      // Commit atomico das alteracoes para os mapas principais
      for (const [k, v] of stagedWallets) {
        this.wallets.set(k, v);
      }
      for (const [k, v] of stagedTransactions) {
        this.transactions.set(k, v);
      }
      for (const entry of stagedLedgerEntries) {
        this.ledgerEntries.push(entry);
      }
      for (const [k, v] of stagedInbox) {
        this.inboxMessages.set(k, v);
      }
      for (const [k, v] of stagedOutbox) {
        this.outboxMessages.set(k, v);
      }
      return result;
    } finally {
      for (const release of heldWalletReleases.reverse()) {
        release();
      }
    }
  }
}
