import { Money } from '../money/money';

/**
 * Direcao da movimentacao financeira no livro-razao (Ledger):
 * - CREDIT: entrada de dinheiro na carteira (ex: OPENING, WIN, REFUND de BET, ROLLBACK de BET).
 * - DEBIT: saida de dinheiro da carteira (ex: BET, ROLLBACK de WIN, ROLLBACK de REFUND).
 */
export type LedgerDirection = 'CREDIT' | 'DEBIT';

/**
 * Tipo de operacao que originou o lancamento no livro-razao.
 * Nota: LOSS nao gera LedgerEntry pois nao movimenta saldo.
 */
export type LedgerOperationType = 'OPENING' | 'BET' | 'WIN' | 'REFUND' | 'ROLLBACK';

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

export interface LedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  operationType: LedgerOperationType;
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface CreateLedgerEntryParams {
  id?: string;
  walletId: string;
  transactionId: string;
  operationType: LedgerOperationType;
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

/**
 * Entidade imutavel de lancamento no Livro-Razao (LedgerEntry).
 *
 * Invariantes financeiras:
 * - Append-only (somente insercao): uma vez criado, nenhum campo pode ser alterado.
 * - O valor movimentado (amount) deve ser estritamente positivo (> 0).
 * - balanceBefore e balanceAfter nunca podem ser negativos.
 * - Mesma moeda (currency) em amount, balanceBefore e balanceAfter.
 * - Consistencia matematica obrigatoria:
 *   - Se CREDIT: balanceBefore + amount === balanceAfter
 *   - Se DEBIT:  balanceBefore - amount === balanceAfter
 */
export class LedgerEntry {
  public readonly id: string;
  public readonly walletId: string;
  public readonly transactionId: string;
  public readonly operationType: LedgerOperationType;
  public readonly direction: LedgerDirection;
  public readonly amount: Money;
  public readonly balanceBefore: Money;
  public readonly balanceAfter: Money;
  public readonly createdAt: Date;

  private constructor(props: LedgerEntryProps) {
    if (!props.walletId || props.walletId.trim().length === 0) {
      throw new InvalidLedgerEntryError('Wallet ID cannot be empty');
    }

    if (!props.transactionId || props.transactionId.trim().length === 0) {
      throw new InvalidLedgerEntryError('Transaction ID cannot be empty');
    }

    if (!props.amount.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger entry amount must be strictly positive');
    }

    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger balances (before/after) cannot be negative');
    }

    if (
      props.amount.currency !== props.balanceBefore.currency ||
      props.amount.currency !== props.balanceAfter.currency
    ) {
      throw new InvalidLedgerEntryError('Currency mismatch between amount, balanceBefore, and balanceAfter');
    }

    const expectedBalanceAfter =
      props.direction === 'CREDIT'
        ? props.balanceBefore.plus(props.amount)
        : props.balanceBefore.minus(props.amount);

    if (!expectedBalanceAfter.equals(props.balanceAfter)) {
      throw new InvalidLedgerEntryError(
        `Ledger mathematical invariant violated for ${props.direction}: ` +
          `balanceBefore (${props.balanceBefore.amount}) ${props.direction === 'CREDIT' ? '+' : '-'} ` +
          `amount (${props.amount.amount}) !== balanceAfter (${props.balanceAfter.amount})`
      );
    }

    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.operationType = props.operationType;
    this.direction = props.direction;
    this.amount = props.amount;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.createdAt = new Date(props.createdAt.getTime());

    Object.freeze(this);
  }

  /**
   * Cria um novo lancamento auditavel validando todas as invariantes matematicas.
   */
  public static create(params: CreateLedgerEntryParams): LedgerEntry {
    return new LedgerEntry({
      id: params.id ?? crypto.randomUUID(),
      walletId: params.walletId,
      transactionId: params.transactionId,
      operationType: params.operationType,
      direction: params.direction,
      amount: params.amount,
      balanceBefore: params.balanceBefore,
      balanceAfter: params.balanceAfter,
      createdAt: params.createdAt ?? new Date(),
    });
  }

  /**
   * Reconstroi um lancamento do banco de dados garantindo que o registro persistido continua integro.
   */
  public static rehydrate(props: LedgerEntryProps): LedgerEntry {
    return new LedgerEntry(props);
  }
}
