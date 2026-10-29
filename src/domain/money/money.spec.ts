import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './money';

describe('Money Value Object', () => {
  describe('Creation and Invariants', () => {
    it('should create Money from valid string with 2 decimal places', () => {
      const money = Money.from('25.50', 'BRL');
      expect(money.amount).toBe('25.50');
      expect(money.currency).toBe('BRL');
      expect(money.toString()).toBe('25.50 BRL');
    });

    it('should normalize integer strings to 2 decimal places', () => {
      const money = Money.from('100');
      expect(money.amount).toBe('100.00');
      expect(money.currency).toBe('BRL');
    });

    it('should normalize 1 decimal place strings to 2 decimal places', () => {
      const money = Money.from('10.5');
      expect(money.amount).toBe('10.50');
    });

    it('should create Money using zero factory', () => {
      const zero = Money.zero();
      expect(zero.amount).toBe('0.00');
      expect(zero.isZero()).toBe(true);
    });

    it('should create Money from cents', () => {
      const money = Money.fromCents(2550);
      expect(money.amount).toBe('25.50');
    });

    it('should reject primitive number as amount to prevent floating-point loss', () => {
      // @ts-expect-error - testing runtime protection against JS consumers
      expect(() => Money.from(25.5)).toThrow(InvalidMoneyError);
    });

    it('should reject empty or whitespace strings', () => {
      expect(() => Money.from('')).toThrow(InvalidMoneyError);
      expect(() => Money.from('   ')).toThrow(InvalidMoneyError);
    });

    it('should reject scientific notation', () => {
      expect(() => Money.from('1e5')).toThrow(InvalidMoneyError);
      expect(() => Money.from('2.5e-3')).toThrow(InvalidMoneyError);
    });

    it('should reject inputs with scale greater than 2 decimal places (no silent rounding)', () => {
      expect(() => Money.from('25.001')).toThrow(InvalidMoneyError);
      expect(() => Money.from('0.0001')).toThrow(InvalidMoneyError);
    });

    it('should reject non-numeric strings', () => {
      expect(() => Money.from('abc')).toThrow(InvalidMoneyError);
      expect(() => Money.from('12.34.56')).toThrow(InvalidMoneyError);
      expect(() => Money.from('NaN')).toThrow(InvalidMoneyError);
      expect(() => Money.from('Infinity')).toThrow(InvalidMoneyError);
    });

    it('should be immutable (Object.isFrozen)', () => {
      const money = Money.from('50.00');
      expect(Object.isFrozen(money)).toBe(true);
    });
  });

  describe('Arithmetic Operations (Exact Precision)', () => {
    it('should add amounts exactly without IEEE-754 precision drift (0.10 + 0.20 = 0.30)', () => {
      const m1 = Money.from('0.10');
      const m2 = Money.from('0.20');
      const sum = m1.plus(m2);

      expect(sum.amount).toBe('0.30');
      expect(m1.amount).toBe('0.10'); // Immutability test
      expect(m2.amount).toBe('0.20');
    });

    it('should subtract amounts correctly', () => {
      const m1 = Money.from('100.00');
      const m2 = Money.from('80.00');
      const result = m1.minus(m2);

      expect(result.amount).toBe('20.00');
    });

    it('should throw CurrencyMismatchError when adding different currencies', () => {
      const brl = Money.from('10.00', 'BRL');
      const usd = Money.from('10.00', 'USD');

      expect(() => brl.plus(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.minus(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.isGreaterThan(usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe('Comparisons and Predicates', () => {
    it('should evaluate equality correctly', () => {
      const a = Money.from('10.00', 'BRL');
      const b = Money.from('10.00', 'BRL');
      const c = Money.from('10.01', 'BRL');
      const d = Money.from('10.00', 'USD');

      expect(a.equals(b)).toBe(true);
      expect(a.equals(c)).toBe(false);
      expect(a.equals(d)).toBe(false);
    });

    it('should compare magnitude properly', () => {
      const m100 = Money.from('100.00');
      const m80 = Money.from('80.00');
      const m100_2 = Money.from('100.00');

      expect(m100.isGreaterThan(m80)).toBe(true);
      expect(m80.isLessThan(m100)).toBe(true);
      expect(m100.isGreaterThanOrEqual(m100_2)).toBe(true);
      expect(m80.isLessThanOrEqual(m100)).toBe(true);
    });

    it('should check positive, negative, and zero states', () => {
      const pos = Money.from('10.00');
      const neg = Money.from('-10.00');
      const zero = Money.from('0.00');

      expect(pos.isPositive()).toBe(true);
      expect(pos.isNegative()).toBe(false);
      expect(pos.isZero()).toBe(false);

      expect(neg.isNegative()).toBe(true);
      expect(neg.isPositive()).toBe(false);

      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON with amount string and currency', () => {
      const money = Money.from('42.00', 'BRL');
      expect(money.toJSON()).toEqual({
        amount: '42.00',
        currency: 'BRL',
      });
    });
  });
});
