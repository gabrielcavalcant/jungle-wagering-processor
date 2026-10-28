/** Application-level errors. Mapped to HTTP status / SQS handling at the edges. */

/** Base for every error this layer raises on purpose (lets the infrastructure tell them apart from driver failures). */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor(readonly playerId: string, readonly currency: string) {
    super(`Wallet already exists for player ${playerId} in ${currency}`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
  constructor(readonly lookup: string) {
    super(`Transaction ${lookup} not found`);
  }
}

/** Same idempotency key, different business payload. Never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
  constructor(readonly idempotencyKey: string, readonly existingTransactionId: string) {
    super(`Idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}

/** Same (providerId, externalTransactionId) submitted under a different idempotency key. */
export class ExternalIdConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_ID_CONFLICT';
  constructor(readonly providerId: string, readonly externalTransactionId: string) {
    super(`Transaction ${providerId}/${externalTransactionId} already exists under another idempotency key`);
  }
}

/** Unique violation on insert: another worker created the row first. Caller re-reads and replays. */
export class IdempotencyRaceError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_RACE';
  constructor(readonly constraint: string) {
    super(`Concurrent insert detected on ${constraint}`);
  }
}

/** Optimistic check failed (version moved). Should not happen under the row lock; retried if it does. */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = 'CONCURRENCY_CONFLICT';
  constructor(readonly walletId: string) {
    super(`Concurrent modification of wallet ${walletId}`);
  }
}

/** Database/broker unreachable, deadlock, serialization failure, timeout: retry later. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_ERROR';
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
  }
}

/** Provider authenticated as X but the payload claims providerId Y. */
export class ProviderForbiddenError extends ApplicationError {
  readonly code = 'PROVIDER_FORBIDDEN';
  constructor(readonly authenticated: string, readonly claimed: string) {
    super(`Authenticated provider ${authenticated} cannot submit for ${claimed}`);
  }
}
