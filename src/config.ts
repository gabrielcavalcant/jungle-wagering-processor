function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Env ${name} must be an integer`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export const CONFIG = Symbol('CONFIG');

export function loadConfig() {
  return {
    instanceId: process.env.INSTANCE_ID ?? `instance-${process.pid}`,
    port: int('PORT', 3000),
    db: {
      host: process.env.DB_HOST ?? 'localhost',
      port: int('DB_PORT', 5432),
      user: process.env.DB_USER ?? 'wagering',
      password: process.env.DB_PASSWORD ?? 'wagering',
      dbName: process.env.DB_NAME ?? 'wagering',
      poolMax: int('DB_POOL_MAX', 20),
      /** lock_timeout per transaction: a stuck lock becomes a transient error instead of hanging forever. */
      lockTimeoutMs: int('DB_LOCK_TIMEOUT_MS', 5_000),
      statementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 15_000),
      connectTimeoutMs: int('DB_CONNECT_TIMEOUT_MS', 3_000),
      acquireTimeoutMs: int('DB_ACQUIRE_TIMEOUT_MS', 10_000),
    },
    sqs: {
      endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
      region: process.env.AWS_REGION ?? 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      inputQueue: process.env.SQS_INPUT_QUEUE ?? 'wager-transactions.fifo',
      dlqQueue: process.env.SQS_DLQ_QUEUE ?? 'wager-transactions-dlq.fifo',
      eventsQueue: process.env.SQS_EVENTS_QUEUE ?? 'wagering-events.fifo',
      consumerName: process.env.SQS_CONSUMER_NAME ?? 'wagering-processor',
      /** Must stay in sync with the queue's redrive maxReceiveCount (scripts/init-sqs). */
      maxReceiveCount: int('SQS_MAX_RECEIVE_COUNT', 5),
      visibilityTimeoutSec: int('SQS_VISIBILITY_TIMEOUT_SEC', 30),
      waitTimeSec: int('SQS_WAIT_TIME_SEC', 10),
      batchSize: int('SQS_BATCH_SIZE', 10),
      retryBaseDelaySec: int('SQS_RETRY_BASE_DELAY_SEC', 2),
      retryMaxDelaySec: int('SQS_RETRY_MAX_DELAY_SEC', 300),
    },
    workers: {
      consumerEnabled: bool('CONSUMER_ENABLED', true),
      outboxEnabled: bool('OUTBOX_PUBLISHER_ENABLED', true),
      pendingReferenceEnabled: bool('PENDING_REFERENCE_WORKER_ENABLED', true),
      outboxPollMs: int('OUTBOX_POLL_MS', 500),
      outboxBatchSize: int('OUTBOX_BATCH_SIZE', 50),
      /** Lease on claimed outbox rows; if the publisher dies, another instance takes over after it expires. */
      outboxLeaseMs: int('OUTBOX_LEASE_MS', 15_000),
      pendingReferencePollMs: int('PENDING_REFERENCE_POLL_MS', 1_000),
    },
    pendingReference: {
      baseDelayMs: int('PENDING_REFERENCE_BASE_DELAY_MS', 1_000),
      maxDelayMs: int('PENDING_REFERENCE_MAX_DELAY_MS', 60_000),
      maxAttempts: int('PENDING_REFERENCE_MAX_ATTEMPTS', 10),
    },
    retention: {
      enabled: bool('RETENTION_ENABLED', true),
      pollMs: int('RETENTION_POLL_MS', 60_000),
      batchSize: int('RETENTION_BATCH_SIZE', 1_000),
      /** Published outbox rows are kept this long (debugging / replays). */
      outboxHours: int('OUTBOX_RETENTION_HOURS', 7 * 24),
      /** Must exceed SQS max message retention (14 days) — otherwise a late redelivery could be re-applied. */
      inboxHours: int('INBOX_RETENTION_HOURS', 15 * 24),
    },
    authMode: (process.env.AUTH_MODE ?? 'none') as 'none' | 'static-token',
    /** Fault injection for crash tests ONLY. "after-commit-before-ack" kills the process at that point. */
    faultInjection: process.env.FAULT_INJECTION ?? '',
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
