import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
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
import {
  LedgerEntry,
  type LedgerDirection,
  type LedgerOperationType,
} from '../../domain/ledger/ledger-entry';
import type { IntegrationEventPayload, IntegrationEventType } from '../../domain/messaging/integration-event';
import {
  InboxMessage,
  type InboxMessageStatus,
  OutboxMessage,
  type OutboxMessageStatus,
} from '../../domain/messaging/outbox-inbox';
import { Money } from '../../domain/money/money';
import {
  type FailureCode,
  IdempotencyConflictError,
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/transaction/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { INITIAL_SCHEMA_UP_SQL } from './migrations/001-initial-schema';

@Injectable()
export class PostgresWageringUnitOfWork
  implements WageringUnitOfWorkPort, OnModuleInit, OnModuleDestroy
{
  private readonly pool: Pool;

  constructor(connectionString?: string) {
    this.pool = new Pool({
      connectionString:
        connectionString ??
        process.env.DATABASE_URL ??
        'postgresql://postgres:postgres@localhost:5432/wagering_processor',
      max: Number(process.env.DB_POOL_MAX ?? 25),
      idleTimeoutMillis: 30_000,
    });
  }

  public async onModuleInit(): Promise<void> {
    if (process.env.AUTO_MIGRATE !== 'false') {
      await this.runMigrations();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  public async runMigrations(): Promise<void> {
    await this.pool.query(INITIAL_SCHEMA_UP_SQL);
  }

  public async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  public getPool(): Pool {
    return this.pool;
  }

  public async runInTransaction<T>(
    work: (repos: TransactionalWageringRepositories) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const repos = this.createRepositories(client);
      const result = await work(repos);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private createRepositories(client: PoolClient): TransactionalWageringRepositories {
    const mapWalletRow = (row: Record<string, unknown>): Wallet =>
      Wallet.restore({
        id: String(row.id),
        playerId: String(row.player_id),
        currency: String(row.currency),
        balance: Money.from(String(row.balance), String(row.currency)),
        version: Number(row.version),
        createdAt: new Date(String(row.created_at)),
        updatedAt: new Date(String(row.updated_at)),
      });

    const mapTxRow = (row: Record<string, unknown>): WagerTransaction =>
      WagerTransaction.rehydrate({
        id: String(row.id),
        providerId: String(row.provider_id),
        externalTransactionId: String(row.external_transaction_id),
        idempotencyKey: String(row.idempotency_key),
        payloadHash: String(row.payload_hash),
        walletId: String(row.wallet_id),
        playerId: String(row.player_id),
        roundId: String(row.round_id),
        gameId: String(row.game_id),
        kind: String(row.kind) as WagerTransactionKind,
        money: Money.from(String(row.amount), String(row.currency)),
        referenceExternalTransactionId: row.reference_external_transaction_id
          ? String(row.reference_external_transaction_id)
          : undefined,
        createdAt: new Date(String(row.created_at)),
        status: String(row.status) as WagerTransactionStatus,
        referenceTransactionId: row.reference_transaction_id
          ? String(row.reference_transaction_id)
          : undefined,
        failureCode: row.failure_code ? (String(row.failure_code) as FailureCode) : undefined,
        processedAt: row.processed_at ? new Date(String(row.processed_at)) : undefined,
        responseSnapshot: (row.response_snapshot as Record<string, unknown> | null) ?? undefined,
      });

    const mapLedgerRow = (row: Record<string, unknown>): LedgerEntry => {
      const currency = String(row.currency);
      return LedgerEntry.rehydrate({
        id: String(row.id),
        walletId: String(row.wallet_id),
        transactionId: String(row.transaction_id),
        direction: String(row.direction) as LedgerDirection,
        operationType: String(row.operation_type) as LedgerOperationType,
        amount: Money.from(String(row.amount), currency),
        balanceBefore: Money.from(String(row.balance_before), currency),
        balanceAfter: Money.from(String(row.balance_after), currency),
        createdAt: new Date(String(row.created_at)),
      });
    };

    return {
      findWalletById: async (walletId: string) => {
        const res = await client.query('SELECT * FROM wallets WHERE id = $1', [walletId]);
        return res.rows[0] ? mapWalletRow(res.rows[0]) : null;
      },

      findWalletByIdForUpdate: async (walletId: string) => {
        const res = await client.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [
          walletId,
        ]);
        return res.rows[0] ? mapWalletRow(res.rows[0]) : null;
      },

      findWalletByPlayerAndCurrency: async (playerId: string, currency: string) => {
        const res = await client.query(
          'SELECT * FROM wallets WHERE player_id = $1 AND currency = $2',
          [playerId, currency.toUpperCase()]
        );
        return res.rows[0] ? mapWalletRow(res.rows[0]) : null;
      },

      insertWallet: async (wallet: Wallet) => {
        try {
          await client.query(
            `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              wallet.id,
              wallet.playerId,
              wallet.currency,
              wallet.balance.amount,
              wallet.version,
              wallet.createdAt,
              wallet.updatedAt,
            ]
          );
        } catch (err: unknown) {
          const pgErr = err as { code?: string };
          if (pgErr.code === '23505') {
            throw new DuplicateWalletError(wallet.playerId, wallet.currency);
          }
          throw err;
        }
      },

      updateWallet: async (wallet: Wallet) => {
        await client.query(
          `UPDATE wallets
           SET balance = $2, version = $3, updated_at = $4
           WHERE id = $1`,
          [wallet.id, wallet.balance.amount, wallet.version, wallet.updatedAt]
        );
      },

      findTransactionById: async (transactionId: string) => {
        const res = await client.query('SELECT * FROM wager_transactions WHERE id = $1', [
          transactionId,
        ]);
        return res.rows[0] ? mapTxRow(res.rows[0]) : null;
      },

      findTransactionByIdempotencyKey: async (idempotencyKey: string) => {
        const res = await client.query(
          'SELECT * FROM wager_transactions WHERE idempotency_key = $1',
          [idempotencyKey]
        );
        return res.rows[0] ? mapTxRow(res.rows[0]) : null;
      },

      findTransactionByProviderAndExternalId: async (
        providerId: string,
        externalTransactionId: string
      ) => {
        const res = await client.query(
          'SELECT * FROM wager_transactions WHERE provider_id = $1 AND external_transaction_id = $2',
          [providerId, externalTransactionId]
        );
        return res.rows[0] ? mapTxRow(res.rows[0]) : null;
      },

      findProcessedReversalForReference: async (referenceTransactionId: string) => {
        const res = await client.query(
          `SELECT * FROM wager_transactions
           WHERE reference_transaction_id = $1
             AND status = 'PROCESSED'
             AND kind IN ('REFUND', 'ROLLBACK')
           LIMIT 1`,
          [referenceTransactionId]
        );
        return res.rows[0] ? mapTxRow(res.rows[0]) : null;
      },

      findPendingReferenceTransactions: async (limit: number) => {
        const res = await client.query(
          `SELECT * FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE'
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED`,
          [limit]
        );
        return res.rows.map(mapTxRow);
      },

      insertTransaction: async (tx: WagerTransaction) => {
        try {
          await client.query(
            `INSERT INTO wager_transactions (
              id, provider_id, external_transaction_id, idempotency_key, payload_hash,
              wallet_id, player_id, round_id, game_id, kind, amount, currency,
              status, failure_code, reference_transaction_id, reference_external_transaction_id,
              response_snapshot, processed_at, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
            [
              tx.id,
              tx.providerId,
              tx.externalTransactionId,
              tx.idempotencyKey,
              tx.payloadHash,
              tx.walletId,
              tx.playerId,
              tx.roundId,
              tx.gameId,
              tx.kind,
              tx.money.amount,
              tx.money.currency,
              tx.status,
              tx.failureCode ?? null,
              tx.referenceTransactionId ?? null,
              tx.referenceExternalTransactionId ?? null,
              tx.responseSnapshot ? JSON.stringify(tx.responseSnapshot) : null,
              tx.processedAt ?? null,
              tx.createdAt,
            ]
          );
        } catch (err: unknown) {
          const pgErr = err as { code?: string; constraint?: string };
          if (pgErr.code === '23505') {
            if (pgErr.constraint?.includes('idempotency')) {
              throw new IdempotencyConflictError(tx.idempotencyKey);
            }
            throw new ExternalTransactionConflictError(tx.providerId, tx.externalTransactionId);
          }
          throw err;
        }
      },

      updateTransaction: async (tx: WagerTransaction) => {
        await client.query(
          `UPDATE wager_transactions
           SET status = $2,
               failure_code = $3,
               reference_transaction_id = $4,
               response_snapshot = $5,
               processed_at = $6
           WHERE id = $1`,
          [
            tx.id,
            tx.status,
            tx.failureCode ?? null,
            tx.referenceTransactionId ?? null,
            tx.responseSnapshot ? JSON.stringify(tx.responseSnapshot) : null,
            tx.processedAt ?? null,
          ]
        );
      },

      insertLedgerEntry: async (entry: LedgerEntry) => {
        await client.query(
          `INSERT INTO wallet_ledger_entries (
            id, wallet_id, transaction_id, direction, operation_type,
            amount, currency, balance_before, balance_after, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            entry.id,
            entry.walletId,
            entry.transactionId,
            entry.direction,
            entry.operationType,
            entry.amount.amount,
            entry.amount.currency,
            entry.balanceBefore.amount,
            entry.balanceAfter.amount,
            entry.createdAt,
          ]
        );
      },

      listLedgerEntriesByWallet: async (
        walletId: string,
        limit: number,
        cursor?: string
      ): Promise<LedgerPageResult> => {
        const res = await client.query(
          `SELECT * FROM wallet_ledger_entries
           WHERE wallet_id = $1
           ORDER BY created_at ASC, id ASC`,
          [walletId]
        );
        const all = res.rows.map(mapLedgerRow);
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
        const res = await client.query(
          `SELECT
             COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0):: NUMERIC(20,2) AS total_credits,
             COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::NUMERIC(20,2) AS total_debits,
             COUNT(*)::INT AS entry_count
           FROM wallet_ledger_entries
           WHERE wallet_id = $1`,
          [walletId]
        );
        const row = res.rows[0] ?? {
          total_credits: '0.00',
          total_debits: '0.00',
          entry_count: 0,
        };
        return {
          totalCredits: Money.from(String(row.total_credits), currency),
          totalDebits: Money.from(String(row.total_debits), currency),
          entryCount: Number(row.entry_count),
        };
      },

      findInboxMessage: async (consumerName: string, messageId: string) => {
        const res = await client.query(
          'SELECT * FROM inbox_messages WHERE consumer_name = $1 AND message_id = $2',
          [consumerName, messageId]
        );
        if (!res.rows[0]) {
          return null;
        }
        const r = res.rows[0];
        return InboxMessage.rehydrate({
          id: String(r.id),
          consumerName: String(r.consumer_name),
          messageId: String(r.message_id),
          payloadHash: String(r.payload_hash),
          status: String(r.status) as InboxMessageStatus,
          processedAt: new Date(String(r.processed_at)),
        });
      },

      insertInboxMessage: async (message: InboxMessage) => {
        await client.query(
          `INSERT INTO inbox_messages (id, consumer_name, message_id, payload_hash, status, processed_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            message.id,
            message.consumerName,
            message.messageId,
            message.payloadHash,
            message.status,
            message.processedAt,
          ]
        );
      },

      insertOutboxMessage: async (message: OutboxMessage) => {
        await client.query(
          `INSERT INTO outbox_messages (
            id, aggregate_type, aggregate_id, event_type, payload,
            status, attempts, next_attempt_at, created_at, published_at, last_error
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            message.id,
            message.aggregateType,
            message.aggregateId,
            message.eventType,
            JSON.stringify(message.payload),
            message.status,
            message.attempts,
            message.nextAttemptAt,
            message.createdAt,
            message.publishedAt ?? null,
            message.lastError ?? null,
          ]
        );
      },

      claimPendingOutboxMessages: async (limit: number, now: Date = new Date()) => {
        const res = await client.query(
          `SELECT * FROM outbox_messages
           WHERE status = 'PENDING' AND next_attempt_at <= $1
           ORDER BY created_at ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED`,
          [now, limit]
        );
        return res.rows.map((r) =>
          OutboxMessage.rehydrate({
            id: String(r.id),
            aggregateType: String(r.aggregate_type),
            aggregateId: String(r.aggregate_id),
            eventType: String(r.event_type) as IntegrationEventType,
            payload: r.payload as IntegrationEventPayload,
            status: String(r.status) as OutboxMessageStatus,
            attempts: Number(r.attempts),
            nextAttemptAt: new Date(String(r.next_attempt_at)),
            createdAt: new Date(String(r.created_at)),
            publishedAt: r.published_at ? new Date(String(r.published_at)) : undefined,
            lastError: r.last_error ? String(r.last_error) : undefined,
          })
        );
      },

      updateOutboxMessage: async (message: OutboxMessage) => {
        await client.query(
          `UPDATE outbox_messages
           SET status = $2, attempts = $3, next_attempt_at = $4, published_at = $5, last_error = $6
           WHERE id = $1`,
          [
            message.id,
            message.status,
            message.attempts,
            message.nextAttemptAt,
            message.publishedAt ?? null,
            message.lastError ?? null,
          ]
        );
      },

      countPendingOutboxMessages: async () => {
        const res = await client.query(
          `SELECT COUNT(*)::INT AS cnt FROM outbox_messages WHERE status = 'PENDING'`
        );
        return Number(res.rows[0]?.cnt ?? 0);
      },
    };
  }
}
