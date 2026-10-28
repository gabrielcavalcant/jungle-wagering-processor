import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { MetricsPort } from '../../application/metrics.port';
import { logger } from './logger';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const transactions = new Counter({
  name: 'wagering_transactions_total',
  help: 'Transactions that reached a state, by status/kind/source',
  labelNames: ['status', 'kind', 'source'] as const,
  registers: [registry],
});
const duplicates = new Counter({
  name: 'wagering_duplicates_detected_total',
  help: 'Duplicates detected (idempotency replay, inbox hit, idempotency conflict)',
  labelNames: ['kind'] as const,
  registers: [registry],
});
const retries = new Counter({
  name: 'wagering_retries_total',
  help: 'Retries by operation and reason',
  labelNames: ['operation', 'reason'] as const,
  registers: [registry],
});
const lockConflicts = new Counter({
  name: 'wagering_lock_conflicts_total',
  help: 'Lock contention events (version mismatch, lock timeout, skip-locked busy wallet)',
  labelNames: ['reason'] as const,
  registers: [registry],
});
const latency = new Histogram({
  name: 'wagering_processing_latency_seconds',
  help: 'End-to-end processing latency of a wager transaction (including retries)',
  labelNames: ['source'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
const divergences = new Counter({
  name: 'wagering_reconciliation_divergences_total',
  help: 'Wallets whose stored balance differs from the ledger',
  registers: [registry],
});
export const dlqMessages = new Counter({
  name: 'wagering_sqs_dlq_messages_total',
  help: 'Messages sent to the DLQ by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});
export const sqsMessages = new Counter({
  name: 'wagering_sqs_messages_total',
  help: 'SQS messages handled by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});
export const outboxPublished = new Counter({
  name: 'wagering_outbox_published_total',
  help: 'Outbox events published',
  labelNames: ['event_type'] as const,
  registers: [registry],
});
export const outboxFailures = new Counter({
  name: 'wagering_outbox_publish_failures_total',
  help: 'Outbox publish failures (will be retried)',
  registers: [registry],
});
export const outboxLag = new Gauge({
  name: 'wagering_outbox_lag_seconds',
  help: 'Age of the oldest unpublished outbox event',
  registers: [registry],
});
export const outboxPending = new Gauge({
  name: 'wagering_outbox_pending',
  help: 'Unpublished outbox events',
  registers: [registry],
});

export class PromMetrics implements MetricsPort {
  transactionFinalized(status: string, kind: string, source: string): void {
    transactions.inc({ status, kind, source });
  }
  duplicateDetected(kind: 'idempotency_replay' | 'inbox_message' | 'idempotency_conflict'): void {
    duplicates.inc({ kind });
  }
  retry(operation: string, reason: string): void {
    retries.inc({ operation, reason });
  }
  lockConflict(reason: string): void {
    lockConflicts.inc({ reason });
  }
  processingLatency(source: string, seconds: number): void {
    latency.observe({ source }, seconds);
  }
  reconciliationDivergence(walletId: string): void {
    divergences.inc();
    logger.error({ walletId, alert: 'RECONCILIATION_DIVERGENCE' }, 'wallet balance diverges from ledger');
  }
}
