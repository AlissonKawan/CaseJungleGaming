import { Money } from '../money/money';

export class InsufficientFundsError extends Error {
  constructor(required: string, available: string) {
    super(`Insufficient funds: required ${required}, but available is ${available}`);
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidWalletOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletOperationError';
  }
}

export interface WalletProps {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWalletParams {
  id?: string;
  playerId: string;
  currency?: string;
  initialBalance?: Money;
}

/**
 * Entidade de Domínio Wallet (Carteira do Jogador).
 * 
 * Invariantes:
 * - O saldo nunca pode ser negativo.
 * - A versão inicia em 1 e é incrementada a cada movimentação que altera o saldo.
 * - Todas as movimentações (crédito/débito) devem usar a mesma moeda da carteira.
 * - Valores de crédito e débito devem ser estritamente positivos (maiores que zero).
 */
export class Wallet {
  private readonly _id: string;
  private readonly _playerId: string;
  private readonly _currency: string;
  private _balance: Money;
  private _version: number;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: WalletProps) {
    if (!props.playerId || props.playerId.trim().length === 0) {
      throw new InvalidWalletOperationError('Player ID cannot be empty');
    }

    if (props.balance.isNegative()) {
      throw new InvalidWalletOperationError('Wallet balance cannot be initialized with a negative amount');
    }

    if (props.balance.currency !== props.currency) {
      throw new InvalidWalletOperationError(
        `Wallet balance currency (${props.balance.currency}) does not match wallet currency (${props.currency})`
      );
    }

    if (props.version < 1) {
      throw new InvalidWalletOperationError('Wallet version must be greater than or equal to 1');
    }

    this._id = props.id;
    this._playerId = props.playerId;
    this._currency = props.currency;
    this._balance = props.balance;
    this._version = props.version;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  /**
   * Cria uma nova carteira com versão inicial 1.
   */
  public static create(params: CreateWalletParams): Wallet {
    const currency = (params.currency ?? 'BRL').toUpperCase();
    const initialBalance = params.initialBalance ?? Money.zero(currency);
    const now = new Date();

    return new Wallet({
      id: params.id ?? crypto.randomUUID(),
      playerId: params.playerId,
      currency,
      balance: initialBalance,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Reconstrói uma carteira existente a partir do banco de dados.
   */
  public static restore(props: WalletProps): Wallet {
    return new Wallet(props);
  }

  public get id(): string {
    return this._id;
  }

  public get playerId(): string {
    return this._playerId;
  }

  public get currency(): string {
    return this._currency;
  }

  public get balance(): Money {
    return this._balance;
  }

  public get version(): number {
    return this._version;
  }

  public get createdAt(): Date {
    return this._createdAt;
  }

  public get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Credita um valor na carteira (WIN, OPENING/DEPOSIT).
   * Incrementa a versão e atualiza o timestamp.
   */
  public credit(amount: Money): void {
    if (!amount.isPositive()) {
      throw new InvalidWalletOperationError('Credit amount must be greater than zero');
    }

    this._balance = this._balance.plus(amount);
    this._version += 1;
    this._updatedAt = new Date();
  }

  /**
   * Debita um valor da carteira (BET).
   * Garante a invariante: saldo NUNCA pode ficar negativo.
   * Se o saldo for insuficiente, lança InsufficientFundsError sem alterar o estado.
   */
  public debit(amount: Money): void {
    if (!amount.isPositive()) {
      throw new InvalidWalletOperationError('Debit amount must be greater than zero');
    }

    if (this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError(amount.amount, this._balance.amount);
    }

    this._balance = this._balance.minus(amount);
    this._version += 1;
    this._updatedAt = new Date();
  }
}
