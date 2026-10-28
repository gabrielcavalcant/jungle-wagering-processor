/**
 * Stable, machine-readable failure taxonomy. Values are part of the public contract:
 * never rename, only add. `retryable` tells the provider whether resending the *same*
 * payload can ever succeed.
 */
export enum FailureCode {
  /** BET larger than the available balance. Provider may retry after a deposit. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** A REFUND/ROLLBACK (or a WIN rollback) would drive the balance negative. Needs manual ops. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** The wallet does not belong to the informed player. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Referenced transaction never arrived within the retry window (see PENDING_REFERENCE). */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Reference exists but belongs to another player/wallet/round/currency. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Reference kind not allowed (REFUND→non-BET, ROLLBACK→LOSS/ROLLBACK/OPENING). */
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  /** Reference exists but was REJECTED/FAILED, so there is nothing to revert. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Reference has already been reverted. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** REFUND/ROLLBACK amount differs from the reference amount (partial reversal unsupported). */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** Permanent infrastructure error recorded for audit (status FAILED). */
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

export const RETRYABLE_FAILURE_CODES: ReadonlySet<FailureCode> = new Set([FailureCode.InsufficientFunds]);
