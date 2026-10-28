export const METRICS = Symbol('METRICS');

/** What the application layer reports. Implemented with prom-client in infrastructure. */
export interface MetricsPort {
  transactionFinalized(status: string, kind: string, source: string): void;
  duplicateDetected(kind: 'idempotency_replay' | 'inbox_message' | 'idempotency_conflict'): void;
  retry(operation: string, reason: string): void;
  lockConflict(reason: string): void;
  processingLatency(source: string, seconds: number): void;
  reconciliationDivergence(walletId: string): void;
}
