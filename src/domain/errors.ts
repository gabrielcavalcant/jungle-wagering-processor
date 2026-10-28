import type { FailureCode } from './failure-codes';

/** Base for every error raised by the domain layer. Never carries infrastructure details. */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed input: invalid money, bad identifiers, OPENING submitted from outside, etc. */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(readonly expected: string, readonly actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/** Raised when an operation would leave the wallet with a negative balance. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor(readonly walletId: string) {
    super(`Insufficient funds in wallet ${walletId}`);
  }
}

/** A business rule rejected the transaction; carries the stable failure code. */
export class BusinessRuleViolation extends DomainError {
  readonly code = 'BUSINESS_RULE_VIOLATION';
  constructor(readonly failureCode: FailureCode, message: string) {
    super(message);
  }
}

/**
 * Programming error: trying to move a transaction out of a terminal state.
 * Not a business path — reaching it means a bug in the orchestration.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(readonly from: string, readonly to: string) {
    super(`Invalid transaction state transition ${from} -> ${to}`);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';
  constructor(message: string) {
    super(message);
  }
}
