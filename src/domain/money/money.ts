import { Decimal } from 'decimal.js';

/**
 * Exceção lançada quando duas quantias de moedas diferentes são combinadas
 */
export class CurrencyMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, but got ${actual}`);
    this.name = 'CurrencyMismatchError';
  }
}

/**
 * Exceção lançada quando uma string monetária inválida é fornecida
 */
export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

/**
 * Value Object Money imutável com precisão decimal exata.
 * 
 * Invariantes:
 * - NUNCA utiliza o tipo number nativo para armazenar ou calcular valores monetários.
 * - Escala fixa de 2 casas decimais (ex: "25.00").
 * - Não realiza arredondamento silencioso em entradas com escala inválida (mais de 2 casas decimais).
 * - Rejeita notação científica, NaN, Infinity e valores não numéricos.
 * - Imutável e com verificação estrita de moeda em todas as operações.
 */
export class Money {
  private readonly _amount: Decimal;
  private readonly _currency: string;

  private static readonly DECIMAL_REGEX = /^-?\d+(\.\d+)?$/;

  private constructor(amount: Decimal, currency: string) {
    this._amount = amount;
    this._currency = currency.toUpperCase();
    Object.freeze(this);
  }

  /**
   * Cria uma instância de Money a partir de uma string decimal precisa.
   * @param rawAmount String representando o valor monetário (ex: "100.50", "25")
   * @param currency Código da moeda (padrão: 'BRL')
   */
  public static from(rawAmount: string, currency: string = 'BRL'): Money {
    if (typeof rawAmount !== 'string') {
      throw new InvalidMoneyError(
        `Money amount must be a string, got ${typeof rawAmount}. Primitive numbers cause floating-point inaccuracy.`
      );
    }

    const trimmed = rawAmount.trim();
    if (trimmed.length === 0) {
      throw new InvalidMoneyError('Money amount cannot be empty');
    }

    // Rejeita notação científica (ex: 1e5, 2.5e-3)
    if (/e/i.test(trimmed)) {
      throw new InvalidMoneyError(`Scientific notation is forbidden for Money: "${rawAmount}"`);
    }

    // Validação estrita de formato numérico
    if (!Money.DECIMAL_REGEX.test(trimmed)) {
      throw new InvalidMoneyError(`Invalid monetary format: "${rawAmount}"`);
    }

    // Verifica a escala decimal (máximo 2 casas decimais, sem arredondar silenciosamente)
    const parts = trimmed.split('.');
    if (parts.length === 2 && (parts[1]?.length ?? 0) > 2) {
      throw new InvalidMoneyError(
        `Invalid decimal scale: money only supports up to 2 decimal places, got "${rawAmount}"`
      );
    }

    let decimal: Decimal;
    try {
      decimal = new Decimal(trimmed);
    } catch {
      throw new InvalidMoneyError(`Could not parse monetary value: "${rawAmount}"`);
    }

    if (!decimal.isFinite()) {
      throw new InvalidMoneyError(`Monetary value must be finite: "${rawAmount}"`);
    }

    return new Money(decimal, currency);
  }

  /**
   * Cria uma instância com valor zero.
   */
  public static zero(currency: string = 'BRL'): Money {
    return new Money(new Decimal(0), currency);
  }

  /**
   * Cria uma instância a partir de centavos (ex: 2550 centavos = "25.50").
   */
  public static fromCents(cents: bigint | number, currency: string = 'BRL'): Money {
    if (typeof cents === 'number' && !Number.isInteger(cents)) {
      throw new InvalidMoneyError(`Cents must be an integer, got ${cents}`);
    }
    const decimal = new Decimal(cents.toString()).dividedBy(100);
    return new Money(decimal, currency);
  }

  /**
   * Retorna o valor formatado sempre com 2 casas decimais (ex: "25.00").
   */
  public get amount(): string {
    return this._amount.toFixed(2);
  }

  /**
   * Retorna a moeda (ex: "BRL").
   */
  public get currency(): string {
    return this._currency;
  }

  public plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this._amount.plus(other._amount), this._currency);
  }

  public minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this._amount.minus(other._amount), this._currency);
  }

  public negate(): Money {
    return new Money(this._amount.negated(), this._currency);
  }

  public isZero(): boolean {
    return this._amount.isZero();
  }

  public isPositive(): boolean {
    return this._amount.isPositive() && !this._amount.isZero();
  }

  public isNegative(): boolean {
    return this._amount.isNegative() && !this._amount.isZero();
  }

  public isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this._amount.greaterThan(other._amount);
  }

  public isGreaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this._amount.greaterThanOrEqualTo(other._amount);
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this._amount.lessThan(other._amount);
  }

  public isLessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this._amount.lessThanOrEqualTo(other._amount);
  }

  public equals(other: Money): boolean {
    return this._currency === other._currency && this._amount.equals(other._amount);
  }

  public toJSON(): { amount: string; currency: string } {
    return {
      amount: this.amount,
      currency: this._currency,
    };
  }

  public toString(): string {
    return `${this.amount} ${this._currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this._currency !== other._currency) {
      throw new CurrencyMismatchError(this._currency, other._currency);
    }
  }
}
