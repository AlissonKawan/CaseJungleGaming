import { describe, expect, it } from 'bun:test';
import { Money } from '../money/money';
import {
  computeCanonicalPayloadHash,
  FailureCode,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

describe('WagerTransaction Domain Entity & Canonical Payload Hash', () => {
  const baseProps = {
    providerId: 'provider-a',
    externalTransactionId: 'ext-tx-100',
    idempotencyKey: 'provider-a:ext-tx-100',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-50',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from('25.00', 'BRL'),
  };

  describe('Creation and Domain Invariants', () => {
    it('should create a BET transaction in PENDING status with deterministic payloadHash', () => {
      const tx = WagerTransaction.create(baseProps);

      expect(tx.status).toBe(WagerTransactionStatus.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.affectsBalance()).toBe(true);
      expect(tx.requiresReference()).toBe(false);
      expect(tx.ledgerDirectionFor()).toBe('DEBIT');
      expect(tx.payloadHash).toHaveLength(64);
    });

    it('should forbid external creation of OPENING transaction unless allowOpening is true', () => {
      expect(() =>
        WagerTransaction.create({
          ...baseProps,
          kind: WagerTransactionKind.Opening,
        })
      ).toThrow(InvalidWagerTransactionError);

      const internalOpening = WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Opening,
        allowOpening: true,
      });
      expect(internalOpening.kind).toBe(WagerTransactionKind.Opening);
      expect(internalOpening.ledgerDirectionFor()).toBe('CREDIT');
    });

    it('should require referenceExternalTransactionId for REFUND and ROLLBACK', () => {
      expect(() =>
        WagerTransaction.create({
          ...baseProps,
          kind: WagerTransactionKind.Refund,
        })
      ).toThrow(InvalidWagerTransactionError);

      expect(() =>
        WagerTransaction.create({
          ...baseProps,
          kind: WagerTransactionKind.Rollback,
        })
      ).toThrow(InvalidWagerTransactionError);

      const refundTx = WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet-1',
      });
      expect(refundTx.requiresReference()).toBe(true);
      expect(refundTx.referenceExternalTransactionId).toBe('ext-bet-1');
    });

    it('should mark LOSS as not affecting balance and forbid ledgerDirectionFor on LOSS', () => {
      const lossTx = WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Loss,
        money: Money.zero('BRL'),
      });

      expect(lossTx.affectsBalance()).toBe(false);
      expect(() => lossTx.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    });

    it('should invert ledger direction for ROLLBACK based on referenced transaction kind', () => {
      const betTx = WagerTransaction.create(baseProps);
      const winTx = WagerTransaction.create({
        ...baseProps,
        externalTransactionId: 'ext-win-1',
        idempotencyKey: 'provider-a:ext-win-1',
        kind: WagerTransactionKind.Win,
      });
      const refundTx = WagerTransaction.create({
        ...baseProps,
        externalTransactionId: 'ext-refund-1',
        idempotencyKey: 'provider-a:ext-refund-1',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-tx-100',
      });
      const rollbackTx = WagerTransaction.create({
        ...baseProps,
        externalTransactionId: 'ext-rb-1',
        idempotencyKey: 'provider-a:ext-rb-1',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'ext-tx-100',
      });

      expect(rollbackTx.ledgerDirectionFor(betTx)).toBe('CREDIT');
      expect(rollbackTx.ledgerDirectionFor(winTx)).toBe('DEBIT');
      expect(rollbackTx.ledgerDirectionFor(refundTx)).toBe('DEBIT');
    });
  });

  describe('State Machine and Terminal State Immutability', () => {
    it('should transition PENDING -> PROCESSED and block any further state transitions', () => {
      const tx = WagerTransaction.create(baseProps);
      const processedAt = new Date('2026-10-29T00:00:00.000Z');

      tx.markProcessed(undefined, processedAt, { balance: { amount: '75.00', currency: 'BRL' } });

      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.processedAt?.toISOString()).toBe('2026-10-29T00:00:00.000Z');
      expect(tx.responseSnapshot).toEqual({ balance: { amount: '75.00', currency: 'BRL' } });

      expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.InfrastructureFailure)).toThrow(InvalidTransactionStateError);
      expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    });

    it('should allow PENDING -> PENDING_REFERENCE -> PROCESSED for out-of-order REFUND/ROLLBACK', () => {
      const rollbackTx = WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'ext-bet-missing',
      });

      rollbackTx.markPendingReference();
      expect(rollbackTx.status).toBe(WagerTransactionStatus.PendingReference);
      expect(rollbackTx.isTerminal()).toBe(false);

      rollbackTx.markProcessed('internal-bet-uuid-123');
      expect(rollbackTx.status).toBe(WagerTransactionStatus.Processed);
      expect(rollbackTx.referenceTransactionId).toBe('internal-bet-uuid-123');
      expect(rollbackTx.isTerminal()).toBe(true);
    });

    it('should allow PENDING_REFERENCE -> REJECTED when retry TTL is exhausted', () => {
      const refundTx = WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet-never-arrived',
      });

      refundTx.markPendingReference();
      refundTx.reject(FailureCode.ReferenceNotFound);

      expect(refundTx.status).toBe(WagerTransactionStatus.Rejected);
      expect(refundTx.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(refundTx.isTerminal()).toBe(true);

      expect(() => refundTx.markProcessed('internal-id')).toThrow(InvalidTransactionStateError);
    });

    it('should distinguish INSUFFICIENT_FUNDS on BET from REVERSAL_INSUFFICIENT_FUNDS on ROLLBACK', () => {
      const betTx = WagerTransaction.create(baseProps);
      betTx.reject(FailureCode.InsufficientFunds);

      const rollbackWinTx = WagerTransaction.create({
        ...baseProps,
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'ext-win-1',
      });
      rollbackWinTx.reject(FailureCode.ReversalInsufficientFunds);

      expect(betTx.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(rollbackWinTx.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(betTx.failureCode).not.toBe(rollbackWinTx.failureCode);
    });
  });

  describe('Idempotency Payload Hash Matching', () => {
    it('should match identical canonical payload and detect conflicting payload with same key', () => {
      const tx = WagerTransaction.create(baseProps);

      const samePayloadHash = computeCanonicalPayloadHash({
        providerId: '  provider-a ',
        externalTransactionId: 'ext-tx-100',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-50',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25', currency: 'brl' },
      });

      const conflictingAmountHash = computeCanonicalPayloadHash({
        providerId: 'provider-a',
        externalTransactionId: 'ext-tx-100',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-50',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
      });

      expect(tx.matchesPayload(samePayloadHash)).toBe(true);
      expect(tx.matchesPayload(conflictingAmountHash)).toBe(false);
    });
  });
});
