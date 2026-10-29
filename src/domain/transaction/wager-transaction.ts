import { createHash } from 'node:crypto';
import type { LedgerDirection } from '../ledger/ledger-entry';
import { Money } from '../money/money';

/**
 * Tipos de operacao de aposta (WagerTransactionKind).
 * - OPENING: credito interno de abertura da carteira (proibido via API/fila externa).
 * - BET: aposta (debito no saldo).
 * - WIN: ganho (credito no saldo).
 * - LOSS: derrota (registra resultado, mas NAO altera saldo nem gera LedgerEntry).
 * - REFUND: reembolso de uma BET processada (credito no saldo).
 * - ROLLBACK: estorno inverso de uma transacao processada (BET -> credito, WIN/REFUND -> debito).
 */
export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

/**
 * Estados do ciclo de vida de uma transacao (WagerTransactionStatus).
 * Estados terminais (PROCESSED, REJECTED, FAILED) sao imutaveis: tentar transiciona-los
 * lanca InvalidTransactionStateError.
 */
export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/**
 * Taxonomia estavel de codigos de falha (Secao 7.2 do desafio).
 * Permite ao provedor de jogos decidir de forma automatizada se deve desistir ou corrigir.
 * Nota importante (Regra 7.9): INSUFFICIENT_FUNDS (falta de saldo em BET) e distinto de
 * REVERSAL_INSUFFICIENT_FUNDS (quando um ROLLBACK de WIN/REFUND deixaria o saldo negativo).
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  DuplicateReversal = 'DUPLICATE_REVERSAL',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerMismatch = 'PLAYER_MISMATCH',
  InvalidOperation = 'INVALID_OPERATION',
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(currentStatus: WagerTransactionStatus, attemptedTransition: string) {
    super(
      `Cannot transition WagerTransaction from terminal or invalid status ${currentStatus} via ${attemptedTransition}`
    );
    this.name = 'InvalidTransactionStateError';
  }
}

export class IdempotencyConflictError extends Error {
  public readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(`Idempotency conflict: key "${idempotencyKey}" was already used with a different business payload`);
    this.name = 'IdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * Subconjunto canonico de campos de negocio que compoem o payloadHash (Secao 9 do README).
 * Metadados de transporte (headers HTTP, messageId do SQS, timestamps de envio) NAO entram no hash.
 */
export interface CanonicalWagerPayloadInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: {
    amount: string;
    currency: string;
  };
  referenceExternalTransactionId?: string;
}

/**
 * Gera um hash SHA-256 deterministico a partir de um JSON canonico com chaves ordenadas.
 * Garante que dois JSONs com os mesmos dados de negocio (mesmo se enviados com ordem de chaves
 * diferente ou espacamento diferente) produzam exatamente o mesmo hash.
 */
export function computeCanonicalPayloadHash(input: CanonicalWagerPayloadInput): string {
  const normalizedAmount = Money.from(input.money.amount, input.money.currency);
  const canonicalObject = {
    externalTransactionId: input.externalTransactionId.trim(),
    gameId: input.gameId.trim(),
    kind: input.kind,
    money: {
      amount: normalizedAmount.amount,
      currency: normalizedAmount.currency,
    },
    playerId: input.playerId.trim(),
    providerId: input.providerId.trim(),
    referenceExternalTransactionId: input.referenceExternalTransactionId?.trim() ?? null,
    roundId: input.roundId.trim(),
    walletId: input.walletId.trim(),
  };

  const canonicalJson = JSON.stringify(canonicalObject);
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

export interface CreateWagerTransactionProps {
  id?: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash?: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
  allowOpening?: boolean;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  responseSnapshot?: Readonly<Record<string, unknown>>;
}

/**
 * Entidade de Dominio WagerTransaction.
 * Representa uma operacao financeira de jogo (BET, WIN, LOSS, REFUND, ROLLBACK, OPENING),
 * sua chave de idempotencia, seu hash de payload canonico e sua maquina de estados.
 */
export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _processedAt?: Date;
  private _responseSnapshot?: Readonly<Record<string, unknown>>;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = new Date(state.createdAt.getTime());
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt ? new Date(state.processedAt.getTime()) : undefined;
    this._responseSnapshot = state.responseSnapshot
      ? Object.freeze({ ...state.responseSnapshot })
      : undefined;
  }

  /**
   * Cria uma nova WagerTransaction em estado PENDING.
   * Valida campos obrigatorios, valor positivo, proibicao de OPENING externo
   * e exigencia de referenceExternalTransactionId para REFUND e ROLLBACK.
   */
  public static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening && !props.allowOpening) {
      throw new InvalidWagerTransactionError(
        'OPENING transaction kind is strictly internal and cannot be submitted externally'
      );
    }

    if (!props.providerId || props.providerId.trim().length === 0) {
      throw new InvalidWagerTransactionError('providerId cannot be empty');
    }
    if (!props.externalTransactionId || props.externalTransactionId.trim().length === 0) {
      throw new InvalidWagerTransactionError('externalTransactionId cannot be empty');
    }
    if (!props.idempotencyKey || props.idempotencyKey.trim().length === 0) {
      throw new InvalidWagerTransactionError('idempotencyKey cannot be empty');
    }
    if (!props.walletId || props.walletId.trim().length === 0) {
      throw new InvalidWagerTransactionError('walletId cannot be empty');
    }
    if (!props.playerId || props.playerId.trim().length === 0) {
      throw new InvalidWagerTransactionError('playerId cannot be empty');
    }
    if (!props.roundId || props.roundId.trim().length === 0) {
      throw new InvalidWagerTransactionError('roundId cannot be empty');
    }
    if (!props.gameId || props.gameId.trim().length === 0) {
      throw new InvalidWagerTransactionError('gameId cannot be empty');
    }

    if (props.kind === WagerTransactionKind.Loss) {
      if (props.money.isNegative()) {
        throw new InvalidWagerTransactionError('LOSS transaction amount cannot be negative');
      }
    } else {
      if (!props.money.isPositive()) {
        throw new InvalidWagerTransactionError(
          `Transaction amount for kind ${props.kind} must be strictly positive`
        );
      }
    }

    const trimmedRef = props.referenceExternalTransactionId?.trim();
    const requiresRef =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;

    if (requiresRef && (!trimmedRef || trimmedRef.length === 0)) {
      throw new InvalidWagerTransactionError(
        `Transaction kind ${props.kind} requires referenceExternalTransactionId`
      );
    }

    if (
      (props.kind === WagerTransactionKind.Bet ||
        props.kind === WagerTransactionKind.Loss ||
        props.kind === WagerTransactionKind.Opening) &&
      trimmedRef
    ) {
      throw new InvalidWagerTransactionError(
        `Transaction kind ${props.kind} cannot have a referenceExternalTransactionId`
      );
    }

    const computedHash =
      props.payloadHash ??
      computeCanonicalPayloadHash({
        providerId: props.providerId,
        externalTransactionId: props.externalTransactionId,
        playerId: props.playerId,
        walletId: props.walletId,
        roundId: props.roundId,
        gameId: props.gameId,
        kind: props.kind,
        money: props.money.toJSON(),
        referenceExternalTransactionId: trimmedRef,
      });

    return new WagerTransaction({
      id: props.id ?? crypto.randomUUID(),
      providerId: props.providerId.trim(),
      externalTransactionId: props.externalTransactionId.trim(),
      idempotencyKey: props.idempotencyKey.trim(),
      payloadHash: computedHash,
      walletId: props.walletId.trim(),
      playerId: props.playerId.trim(),
      roundId: props.roundId.trim(),
      gameId: props.gameId.trim(),
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: trimmedRef,
      createdAt: props.createdAt ?? new Date(),
      status: WagerTransactionStatus.Pending,
    });
  }

  /**
   * Reidrata uma transacao vinda do banco de dados sem reexecutar regras de criacao.
   */
  public static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  public get status(): WagerTransactionStatus {
    return this._status;
  }

  public get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  public get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  public get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  public get responseSnapshot(): Readonly<Record<string, unknown>> | undefined {
    return this._responseSnapshot;
  }

  /**
   * Verifica se o estado atual e terminal (PROCESSED, REJECTED ou FAILED).
   * Uma vez em estado terminal, a transacao jamais pode mudar de estado.
   */
  public isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  /**
   * Indica se o tipo de transacao altera o saldo da carteira.
   * Retorna false apenas para LOSS (que apenas registra o desfecho da rodada).
   */
  public affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /**
   * Indica se a operacao exige uma transacao de referencia obrigatoria (REFUND e ROLLBACK).
   */
  public requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback
    );
  }

  /**
   * Compara o hash recebido com o payloadHash gravado na transacao.
   * Usado para detectar se uma repeticao de Idempotency-Key e um replay legitimo (true)
   * ou um conflito de payload diferente (false -> IdempotencyConflictError).
   */
  public matchesPayload(candidatePayloadHash: string): boolean {
    return this.payloadHash === candidatePayloadHash;
  }

  /**
   * Determina a direcao do lancamento no Ledger (CREDIT ou DEBIT) para esta transacao.
   * - OPENING, WIN, REFUND -> CREDIT
   * - BET -> DEBIT
   * - ROLLBACK -> inverte o efeito da transacao referenciada:
   *     - ROLLBACK de BET -> CREDIT (devolve o dinheiro debitado)
   *     - ROLLBACK de WIN ou REFUND -> DEBIT (estorna o dinheiro creditado)
   * - LOSS -> lanca erro pois LOSS nao gera entrada no Ledger.
   */
  public ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return 'CREDIT';
      case WagerTransactionKind.Bet:
        return 'DEBIT';
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError(
            'Reference transaction is required to determine ledger direction for ROLLBACK'
          );
        }
        if (reference.kind === WagerTransactionKind.Bet) {
          return 'CREDIT';
        }
        if (
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund
        ) {
          return 'DEBIT';
        }
        throw new InvalidWagerTransactionError(
          `Cannot rollback transaction of kind ${reference.kind}`
        );
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS transaction does not generate a ledger entry');
    }
  }

  /**
   * Marca a transacao como PROCESSED (estado terminal).
   * So pode ser chamado a partir de PENDING ou PENDING_REFERENCE.
   */
  public markProcessed(
    referenceTransactionId: string | undefined,
    at: Date = new Date(),
    responseSnapshot?: Record<string, unknown>
  ): void {
    this.assertNotTerminal('markProcessed');

    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidWagerTransactionError(
        `Cannot mark ${this.kind} as PROCESSED without resolved referenceTransactionId`
      );
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = undefined;
    this._processedAt = new Date(at.getTime());
    if (responseSnapshot) {
      this._responseSnapshot = Object.freeze({ ...responseSnapshot });
    }
  }

  /**
   * Marca a transacao como PENDING_REFERENCE quando a transacao referenciada
   * (em um REFUND ou ROLLBACK fora de ordem) ainda nao chegou ao banco.
   */
  public markPendingReference(): void {
    this.assertNotTerminal('markPendingReference');

    if (!this.requiresReference() && this.kind !== WagerTransactionKind.Win) {
      throw new InvalidTransactionStateError(this._status, 'markPendingReference');
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  /**
   * Rejeita a transacao por violacao de regra de negocio (estado terminal REJECTED).
   * Exige um FailureCode explicito (ex: INSUFFICIENT_FUNDS, DUPLICATE_REVERSAL).
   */
  public reject(
    code: FailureCode,
    at: Date = new Date(),
    responseSnapshot?: Record<string, unknown>
  ): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = new Date(at.getTime());
    if (responseSnapshot) {
      this._responseSnapshot = Object.freeze({ ...responseSnapshot });
    }
  }

  /**
   * Marca a transacao como FAILED (erro permanente de infraestrutura, estado terminal).
   */
  public fail(code: FailureCode = FailureCode.InfrastructureFailure, at: Date = new Date()): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date(at.getTime());
  }

  /**
   * Registra o snapshot da resposta historica observada no momento da conclusao
   * para garantir replay idempotente exato (Secao 7, Regra 7).
   */
  public attachResponseSnapshot(snapshot: Record<string, unknown>): void {
    this._responseSnapshot = Object.freeze({ ...snapshot });
  }

  private assertNotTerminal(attemptedTransition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, attemptedTransition);
    }
  }
}
