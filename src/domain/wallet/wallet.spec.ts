import { describe, expect, it } from 'bun:test';
import { Money, CurrencyMismatchError } from '../money/money';
import { Wallet, InsufficientFundsError, InvalidWalletOperationError } from './wallet';

describe('Wallet Entity', () => {
  describe('Creation and Invariants', () => {
    it('should create a new wallet with zero balance and version 1 by default', () => {
      const wallet = Wallet.create({ playerId: 'player-123' });

      expect(wallet.id).toBeDefined();
      expect(wallet.playerId).toBe('player-123');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.amount).toBe('0.00');
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toBeInstanceOf(Date);
      expect(wallet.updatedAt).toBeInstanceOf(Date);
    });

    it('should create a wallet with custom initial balance and currency', () => {
      const initialBalance = Money.from('150.00', 'USD');
      const wallet = Wallet.create({
        playerId: 'player-456',
        currency: 'USD',
        initialBalance,
      });

      expect(wallet.balance.amount).toBe('150.00');
      expect(wallet.currency).toBe('USD');
      expect(wallet.version).toBe(1);
    });

    it('should reject creation with empty playerId', () => {
      expect(() => Wallet.create({ playerId: '   ' })).toThrow(InvalidWalletOperationError);
    });

    it('should reject creation when initialBalance currency mismatches wallet currency', () => {
      const initialBalance = Money.from('50.00', 'USD');
      expect(() =>
        Wallet.create({
          playerId: 'player-123',
          currency: 'BRL',
          initialBalance,
        })
      ).toThrow(InvalidWalletOperationError);
    });
  });

  describe('Credit Operations (WIN / OPENING)', () => {
    it('should increase balance and increment version on credit', () => {
      const wallet = Wallet.create({ playerId: 'player-1' });
      const deposit = Money.from('100.00', 'BRL');

      wallet.credit(deposit);

      expect(wallet.balance.amount).toBe('100.00');
      expect(wallet.version).toBe(2);
    });

    it('should accumulate multiple credits correctly', () => {
      const wallet = Wallet.create({ playerId: 'player-1' });
      wallet.credit(Money.from('50.25', 'BRL'));
      wallet.credit(Money.from('25.75', 'BRL'));

      expect(wallet.balance.amount).toBe('76.00');
      expect(wallet.version).toBe(3);
    });

    it('should reject credit of zero or negative amount', () => {
      const wallet = Wallet.create({ playerId: 'player-1' });
      expect(() => wallet.credit(Money.zero('BRL'))).toThrow(InvalidWalletOperationError);
      expect(() => wallet.credit(Money.from('-10.00', 'BRL'))).toThrow(InvalidWalletOperationError);
    });

    it('should reject credit with mismatched currency', () => {
      const wallet = Wallet.create({ playerId: 'player-1', currency: 'BRL' });
      expect(() => wallet.credit(Money.from('50.00', 'USD'))).toThrow(CurrencyMismatchError);
    });
  });

  describe('Debit Operations (BET)', () => {
    it('should decrease balance and increment version when funds are sufficient', () => {
      const wallet = Wallet.create({
        playerId: 'player-1',
        initialBalance: Money.from('100.00', 'BRL'),
      });

      wallet.debit(Money.from('40.00', 'BRL'));

      expect(wallet.balance.amount).toBe('60.00');
      expect(wallet.version).toBe(2);
    });

    it('should allow debiting the exact full balance down to zero', () => {
      const wallet = Wallet.create({
        playerId: 'player-1',
        initialBalance: Money.from('100.00', 'BRL'),
      });

      wallet.debit(Money.from('100.00', 'BRL'));

      expect(wallet.balance.amount).toBe('0.00');
      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(2);
    });

    it('should throw InsufficientFundsError and keep state intact when balance is lower than debit', () => {
      const wallet = Wallet.create({
        playerId: 'player-1',
        initialBalance: Money.from('50.00', 'BRL'),
      });

      expect(() => wallet.debit(Money.from('80.00', 'BRL'))).toThrow(InsufficientFundsError);

      // Saldo e versão permanecem inalterados
      expect(wallet.balance.amount).toBe('50.00');
      expect(wallet.version).toBe(1);
    });

    it('should reject debit of zero or negative amount', () => {
      const wallet = Wallet.create({
        playerId: 'player-1',
        initialBalance: Money.from('100.00', 'BRL'),
      });

      expect(() => wallet.debit(Money.zero('BRL'))).toThrow(InvalidWalletOperationError);
      expect(() => wallet.debit(Money.from('-10.00', 'BRL'))).toThrow(InvalidWalletOperationError);
    });

    it('should reject debit with mismatched currency', () => {
      const wallet = Wallet.create({
        playerId: 'player-1',
        initialBalance: Money.from('100.00', 'BRL'),
      });

      expect(() => wallet.debit(Money.from('10.00', 'USD'))).toThrow(CurrencyMismatchError);
    });
  });
});
