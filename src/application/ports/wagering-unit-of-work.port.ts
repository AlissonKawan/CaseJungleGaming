import type { LedgerEntry } from '../../domain/ledger/ledger-entry';
import type { InboxMessage, OutboxMessage } from '../../domain/messaging/outbox-inbox';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/transaction/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

export interface LedgerPageResult {
  items: LedgerEntry[];
  nextCursor: string | null;
}

export interface LedgerTotals {
  totalCredits: Money;
  totalDebits: Money;
  entryCount: number;
}

/**
 * Repositorio transacional executado DENTRO de uma transacao de banco de dados (ACID).
 * Em Spring Boot, equivale aos Repositories chamados dentro de um metodo anotado com @Transactional.
 */
export interface TransactionalWageringRepositories {
  findWalletById(walletId: string): Promise<Wallet | null>;
  findWalletByIdForUpdate(walletId: string): Promise<Wallet | null>;
  findWalletByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  insertWallet(wallet: Wallet): Promise<void>;
  updateWallet(wallet: Wallet): Promise<void>;

  findTransactionById(transactionId: string): Promise<WagerTransaction | null>;
  findTransactionByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;
  findTransactionByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string
  ): Promise<WagerTransaction | null>;
  findProcessedReversalForReference(
    referenceTransactionId: string
  ): Promise<WagerTransaction | null>;
  findPendingReferenceTransactions(limit: number): Promise<WagerTransaction[]>;
  insertTransaction(transaction: WagerTransaction): Promise<void>;
  updateTransaction(transaction: WagerTransaction): Promise<void>;

  insertLedgerEntry(entry: LedgerEntry): Promise<void>;
  listLedgerEntriesByWallet(
    walletId: string,
    limit: number,
    cursor?: string
  ): Promise<LedgerPageResult>;
  computeLedgerTotals(walletId: string, currency: string): Promise<LedgerTotals>;

  findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  insertInboxMessage(message: InboxMessage): Promise<void>;

  insertOutboxMessage(message: OutboxMessage): Promise<void>;
  claimPendingOutboxMessages(limit: number, now?: Date): Promise<OutboxMessage[]>;
  updateOutboxMessage(message: OutboxMessage): Promise<void>;
  countPendingOutboxMessages(): Promise<number>;
}

export const WAGERING_UNIT_OF_WORK = Symbol('WAGERING_UNIT_OF_WORK');

/**
 * Porta de Unidade de Trabalho (Unit of Work).
 * Abre uma transacao SQL (BEGIN ... COMMIT / ROLLBACK) e entrega os repositorios transacionais.
 */
export interface WageringUnitOfWorkPort {
  runInTransaction<T>(
    work: (repos: TransactionalWageringRepositories) => Promise<T>
  ): Promise<T>;

  ping(): Promise<boolean>;
}
