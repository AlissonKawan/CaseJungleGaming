export class EntityNotFoundError extends Error {
  public readonly entityName: string;
  public readonly identifier: string;

  constructor(entityName: string, identifier: string) {
    super(`${entityName} not found: ${identifier}`);
    this.name = 'EntityNotFoundError';
    this.entityName = entityName;
    this.identifier = identifier;
  }
}

export class DuplicateWalletError extends Error {
  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for playerId=${playerId} and currency=${currency}`);
    this.name = 'DuplicateWalletError';
  }
}

export class ExternalTransactionConflictError extends Error {
  constructor(providerId: string, externalTransactionId: string) {
    super(
      `External transaction (${providerId}, ${externalTransactionId}) already exists with different idempotency key or payload`
    );
    this.name = 'ExternalTransactionConflictError';
  }
}
