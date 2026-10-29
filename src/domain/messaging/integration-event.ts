import type { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../transaction/wager-transaction';

export enum IntegrationEventType {
  WagerTransactionProcessed = 'WagerTransactionProcessed',
  WagerTransactionRejected = 'WagerTransactionRejected',
  WalletBalanceChanged = 'WalletBalanceChanged',
  WagerTransactionPendingReference = 'WagerTransactionPendingReference',
}

export interface WagerTransactionProcessedPayload {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus.Processed;
  amount: string;
  currency: string;
  balanceAfter: string;
  processedAt: string;
}

export interface WagerTransactionRejectedPayload {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus.Rejected;
  failureCode: FailureCode;
  amount: string;
  currency: string;
  rejectedAt: string;
}

export interface WalletBalanceChangedPayload {
  walletId: string;
  playerId: string;
  transactionId: string;
  ledgerEntryId: string;
  direction: 'CREDIT' | 'DEBIT';
  operationType: 'OPENING' | 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  occurredAt: string;
}

export interface WagerTransactionPendingReferencePayload {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  recordedAt: string;
}

export type IntegrationEventPayload =
  | WagerTransactionProcessedPayload
  | WagerTransactionRejectedPayload
  | WalletBalanceChangedPayload
  | WagerTransactionPendingReferencePayload;
