import type { IntegrationEventPayload, IntegrationEventType } from './integration-event';

export enum InboxMessageStatus {
  Processed = 'PROCESSED',
  Failed = 'FAILED',
}

export interface InboxMessageProps {
  id: string;
  consumerName: string;
  messageId: string;
  payloadHash: string;
  status: InboxMessageStatus;
  processedAt: Date;
}

/**
 * Entidade InboxMessage (Idempotent Receiver Pattern).
 * Garante que a mesma mensagem do SQS nao seja processada duas vezes pelo mesmo consumidor,
 * e detecta conflito caso o mesmo messageId chegue com um payloadHash diferente.
 */
export class InboxMessage {
  public readonly id: string;
  public readonly consumerName: string;
  public readonly messageId: string;
  public readonly payloadHash: string;
  public readonly status: InboxMessageStatus;
  public readonly processedAt: Date;

  private constructor(props: InboxMessageProps) {
    this.id = props.id;
    this.consumerName = props.consumerName.trim();
    this.messageId = props.messageId.trim();
    this.payloadHash = props.payloadHash.trim();
    this.status = props.status;
    this.processedAt = new Date(props.processedAt.getTime());
    Object.freeze(this);
  }

  public static create(props: {
    id?: string;
    consumerName: string;
    messageId: string;
    payloadHash: string;
    status?: InboxMessageStatus;
    processedAt?: Date;
  }): InboxMessage {
    if (!props.consumerName || props.consumerName.trim().length === 0) {
      throw new Error('InboxMessage consumerName cannot be empty');
    }
    if (!props.messageId || props.messageId.trim().length === 0) {
      throw new Error('InboxMessage messageId cannot be empty');
    }
    if (!props.payloadHash || props.payloadHash.trim().length === 0) {
      throw new Error('InboxMessage payloadHash cannot be empty');
    }

    return new InboxMessage({
      id: props.id ?? crypto.randomUUID(),
      consumerName: props.consumerName,
      messageId: props.messageId,
      payloadHash: props.payloadHash,
      status: props.status ?? InboxMessageStatus.Processed,
      processedAt: props.processedAt ?? new Date(),
    });
  }

  public static rehydrate(props: InboxMessageProps): InboxMessage {
    return new InboxMessage(props);
  }
}

export enum OutboxMessageStatus {
  Pending = 'PENDING',
  Published = 'PUBLISHED',
  Failed = 'FAILED',
}

export interface OutboxMessageProps {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: IntegrationEventType;
  payload: IntegrationEventPayload;
  status: OutboxMessageStatus;
  attempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  publishedAt?: Date;
  lastError?: string;
}

/**
 * Entidade OutboxMessage (Transactional Outbox Pattern).
 * Salva o evento de integracao na mesma transacao SQL que alterou a Wallet, Ledger e WagerTransaction.
 * Um worker separado le os registros PENDING com SELECT ... FOR UPDATE SKIP LOCKED e publica no SQS.
 */
export class OutboxMessage {
  public readonly id: string;
  public readonly aggregateType: string;
  public readonly aggregateId: string;
  public readonly eventType: IntegrationEventType;
  public readonly payload: IntegrationEventPayload;
  public readonly createdAt: Date;

  private _status: OutboxMessageStatus;
  private _attempts: number;
  private _nextAttemptAt: Date;
  private _publishedAt?: Date;
  private _lastError?: string;

  private constructor(props: OutboxMessageProps) {
    this.id = props.id;
    this.aggregateType = props.aggregateType;
    this.aggregateId = props.aggregateId;
    this.eventType = props.eventType;
    this.payload = Object.freeze({ ...props.payload });
    this.createdAt = new Date(props.createdAt.getTime());
    this._status = props.status;
    this._attempts = props.attempts;
    this._nextAttemptAt = new Date(props.nextAttemptAt.getTime());
    this._publishedAt = props.publishedAt ? new Date(props.publishedAt.getTime()) : undefined;
    this._lastError = props.lastError;
  }

  public static create(props: {
    id?: string;
    aggregateType: string;
    aggregateId: string;
    eventType: IntegrationEventType;
    payload: IntegrationEventPayload;
    createdAt?: Date;
  }): OutboxMessage {
    const now = props.createdAt ?? new Date();
    return new OutboxMessage({
      id: props.id ?? crypto.randomUUID(),
      aggregateType: props.aggregateType,
      aggregateId: props.aggregateId,
      eventType: props.eventType,
      payload: props.payload,
      status: OutboxMessageStatus.Pending,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    });
  }

  public static rehydrate(props: OutboxMessageProps): OutboxMessage {
    return new OutboxMessage(props);
  }

  public get status(): OutboxMessageStatus {
    return this._status;
  }

  public get attempts(): number {
    return this._attempts;
  }

  public get nextAttemptAt(): Date {
    return new Date(this._nextAttemptAt.getTime());
  }

  public get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt.getTime()) : undefined;
  }

  public get lastError(): string | undefined {
    return this._lastError;
  }

  public markPublished(at: Date = new Date()): void {
    this._status = OutboxMessageStatus.Published;
    this._publishedAt = new Date(at.getTime());
    this._lastError = undefined;
  }

  public recordAttemptFailure(
    errorMessage: string,
    maxAttempts: number = 10,
    now: Date = new Date()
  ): void {
    this._attempts += 1;
    this._lastError = errorMessage;
    if (this._attempts >= maxAttempts) {
      this._status = OutboxMessageStatus.Failed;
      return;
    }
    const backoffMs = Math.min(60_000, 500 * Math.pow(2, this._attempts - 1));
    this._nextAttemptAt = new Date(now.getTime() + backoffMs);
  }
}
