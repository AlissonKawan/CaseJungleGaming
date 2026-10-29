import { describe, expect, it } from 'bun:test';
import { Money } from '../money/money';
import { InvalidLedgerEntryError, LedgerEntry } from './ledger-entry';

describe('LedgerEntry Domain Entity', () => {
  it('should create a valid CREDIT ledger entry when balanceBefore + amount == balanceAfter', () => {
    const entry = LedgerEntry.create({
      walletId: 'wallet-1',
      transactionId: 'tx-100',
      operationType: 'WIN',
      direction: 'CREDIT',
      amount: Money.from('50.00', 'BRL'),
      balanceBefore: Money.from('100.00', 'BRL'),
      balanceAfter: Money.from('150.00', 'BRL'),
    });

    expect(entry.id).toBeDefined();
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-100');
    expect(entry.operationType).toBe('WIN');
    expect(entry.direction).toBe('CREDIT');
    expect(entry.amount.amount).toBe('50.00');
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('150.00');
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it('should create a valid DEBIT ledger entry when balanceBefore - amount == balanceAfter', () => {
    const entry = LedgerEntry.create({
      walletId: 'wallet-1',
      transactionId: 'tx-101',
      operationType: 'BET',
      direction: 'DEBIT',
      amount: Money.from('40.00', 'BRL'),
      balanceBefore: Money.from('100.00', 'BRL'),
      balanceAfter: Money.from('60.00', 'BRL'),
    });

    expect(entry.direction).toBe('DEBIT');
    expect(entry.balanceAfter.amount).toBe('60.00');
  });

  it('should reject CREDIT entry when mathematical transition is inconsistent', () => {
    expect(() =>
      LedgerEntry.create({
        walletId: 'wallet-1',
        transactionId: 'tx-102',
        operationType: 'WIN',
        direction: 'CREDIT',
        amount: Money.from('50.00', 'BRL'),
        balanceBefore: Money.from('100.00', 'BRL'),
        balanceAfter: Money.from('140.00', 'BRL'), // Deveria ser 150.00
      })
    ).toThrow(InvalidLedgerEntryError);
  });

  it('should reject DEBIT entry when mathematical transition is inconsistent', () => {
    expect(() =>
      LedgerEntry.create({
        walletId: 'wallet-1',
        transactionId: 'tx-103',
        operationType: 'BET',
        direction: 'DEBIT',
        amount: Money.from('40.00', 'BRL'),
        balanceBefore: Money.from('100.00', 'BRL'),
        balanceAfter: Money.from('70.00', 'BRL'), // Deveria ser 60.00
      })
    ).toThrow(InvalidLedgerEntryError);
  });

  it('should reject zero or negative entry amount', () => {
    expect(() =>
      LedgerEntry.create({
        walletId: 'wallet-1',
        transactionId: 'tx-104',
        operationType: 'BET',
        direction: 'DEBIT',
        amount: Money.zero('BRL'),
        balanceBefore: Money.from('100.00', 'BRL'),
        balanceAfter: Money.from('100.00', 'BRL'),
      })
    ).toThrow(InvalidLedgerEntryError);
  });

  it('should reject negative balanceBefore or balanceAfter', () => {
    expect(() =>
      LedgerEntry.create({
        walletId: 'wallet-1',
        transactionId: 'tx-105',
        operationType: 'BET',
        direction: 'DEBIT',
        amount: Money.from('120.00', 'BRL'),
        balanceBefore: Money.from('100.00', 'BRL'),
        balanceAfter: Money.from('-20.00', 'BRL'),
      })
    ).toThrow(InvalidLedgerEntryError);
  });

  it('should reject currency mismatch between amount and balances', () => {
    expect(() =>
      LedgerEntry.create({
        walletId: 'wallet-1',
        transactionId: 'tx-106',
        operationType: 'WIN',
        direction: 'CREDIT',
        amount: Money.from('50.00', 'USD'),
        balanceBefore: Money.from('100.00', 'BRL'),
        balanceAfter: Money.from('150.00', 'BRL'),
      })
    ).toThrow(InvalidLedgerEntryError);
  });

  it('should reject empty walletId or transactionId', () => {
    expect(() =>
      LedgerEntry.create({
        walletId: '   ',
        transactionId: 'tx-107',
        operationType: 'WIN',
        direction: 'CREDIT',
        amount: Money.from('10.00', 'BRL'),
        balanceBefore: Money.from('0.00', 'BRL'),
        balanceAfter: Money.from('10.00', 'BRL'),
      })
    ).toThrow(InvalidLedgerEntryError);

    expect(() =>
      LedgerEntry.create({
        walletId: 'wallet-1',
        transactionId: '',
        operationType: 'WIN',
        direction: 'CREDIT',
        amount: Money.from('10.00', 'BRL'),
        balanceBefore: Money.from('0.00', 'BRL'),
        balanceAfter: Money.from('10.00', 'BRL'),
      })
    ).toThrow(InvalidLedgerEntryError);
  });
});
