import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { ProcessPendingReferencesUseCase } from '../../application/process-pending-references.usecase';
import type { AppConfig } from '../../config';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { OutboxStore } from '../persistence/outbox-store';
import { logger } from '../observability/logger';
import { outboxFailures, outboxLag, outboxPending, outboxPublished } from '../observability/metrics';
import type { SqsGateway } from './sqs';

/** Runs `tick` every `intervalMs`, never overlapping itself; `stop()` waits for the current tick. */
export class PeriodicWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private current?: Promise<unknown>;
  private running = false;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<unknown>,
  ) {}

  start(): void {
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.current?.catch(() => undefined);
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      this.current = this.tick().catch((error) =>
        logger.warn({ worker: this.name, err: error instanceof Error ? error.message : String(error) }, 'worker tick failed'),
      );
      await this.current;
      this.schedule(this.intervalMs);
    }, delay);
  }
}

/**
 * Publishes committed outbox rows to wagering-events.fifo. Many instances can run it at once.
 * Ordering: a claim hands a publisher whole per-wallet streams (see OutboxStore.claim); each
 * stream is published in `sequence` order and stops at the first failure, so a wallet's
 * events reach the queue in commit order. Different wallets are published in parallel.
 * Delivery is at-least-once (crashed publisher → lease expires → republish); events carry
 * MessageDeduplicationId = eventId and eventId/sequence attributes for consumer-side dedup.
 */
export class OutboxPublisher {
  constructor(
    private readonly store: OutboxStore,
    private readonly sqs: SqsGateway,
    private readonly config: AppConfig,
  ) {}

  async publishOnce(): Promise<number> {
    const publisherId = this.config.instanceId;
    const batch = await this.store.claim(publisherId, this.config.workers.outboxBatchSize, this.config.workers.outboxLeaseMs);
    const streams = new Map<string, OutboxMessage[]>();
    for (const m of batch) streams.set(m.aggregateId, [...(streams.get(m.aggregateId) ?? []), m]);
    const counts = await Promise.all([...streams.values()].map((stream) => this.publishStream(publisherId, stream)));
    const { lag, pending } = await this.store.lagSeconds();
    outboxLag.set(lag);
    outboxPending.set(pending);
    return counts.reduce((a, b) => a + b, 0);
  }

  /** One wallet's events, already sorted by sequence. Returns how many were marked published. */
  private async publishStream(publisherId: string, stream: OutboxMessage[]): Promise<number> {
    let published = 0;
    for (let i = 0; i < stream.length; i += 10) {
      const chunk = stream.slice(i, i + 10);
      const now = new Date();
      let failed: Map<number, string>;
      try {
        const res = await this.sqs.client.send(
          new SendMessageBatchCommand({
            QueueUrl: await this.sqs.eventsQueueUrl(),
            Entries: chunk.map((m, idx) => ({
              Id: String(idx),
              MessageBody: JSON.stringify(m.payload),
              MessageGroupId: m.aggregateId,
              MessageDeduplicationId: m.id,
              MessageAttributes: {
                eventType: { DataType: 'String', StringValue: m.eventType },
                eventId: { DataType: 'String', StringValue: m.id },
                sequence: { DataType: 'Number', StringValue: String(m.sequence ?? 0) },
              },
            })),
          }),
        );
        failed = new Map((res.Failed ?? []).map((f) => [Number(f.Id), f.Message ?? f.Code ?? 'failed']));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ err: message, aggregateId: chunk[0]!.aggregateId, count: chunk.length }, 'outbox publish failed; scheduling retry');
        failed = new Map(chunk.map((_, idx) => [idx, message]));
      }

      // Whatever SQS accepted is on the queue: record it, even past a failed entry (it cannot be unsent).
      const succeeded = chunk.filter((_, idx) => !failed.has(idx));
      succeeded.forEach((m) => m.markPublished(now));
      const marked = await this.store.markPublishedMany(publisherId, succeeded.map((m) => m.id), now);
      for (const m of succeeded) {
        if (!marked.has(m.id)) continue; // lease lost meanwhile: someone else owns the row now
        published++;
        outboxPublished.inc({ event_type: m.eventType });
      }
      if (failed.size === 0) continue;

      // Failure: back off the failed rows; the wallet's stream waits behind its head until it goes out.
      for (const [idx, reason] of failed) {
        const m = chunk[idx]!;
        m.scheduleRetry(now, reason);
        await this.store.scheduleRetry(publisherId, m).catch(() => undefined);
        outboxFailures.inc();
      }
      await this.store.release(publisherId, stream.slice(i + 10).map((m) => m.id)).catch(() => undefined);
      break;
    }
    return published;
  }
}

export function pendingReferenceTick(useCase: ProcessPendingReferencesUseCase) {
  return async () => {
    const result = await useCase.runOnce();
    if (result.resolved || result.rescheduled) logger.info({ ...result }, 'pending references processed');
  };
}
