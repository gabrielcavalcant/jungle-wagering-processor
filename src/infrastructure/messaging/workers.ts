import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { ProcessPendingReferencesUseCase } from '../../application/process-pending-references.usecase';
import type { AppConfig } from '../../config';
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
 * Publishes committed outbox rows to wagering-events.fifo. Many instances can run it at once:
 * rows are leased with SKIP LOCKED, so each row has one active publisher at a time; a crashed
 * publisher's lease expires and the row is picked up again (at-least-once). Events are sent with
 * MessageDeduplicationId = eventId and carry eventId in the body for consumer-side dedup.
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
    let published = 0;
    for (let i = 0; i < batch.length; i += 10) {
      const chunk = batch.slice(i, i + 10);
      const now = new Date();
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
              },
            })),
          }),
        );
        const failed = new Map((res.Failed ?? []).map((f) => [Number(f.Id), f.Message ?? f.Code ?? 'failed']));
        const succeeded = chunk.filter((_, idx) => !failed.has(idx));
        for (const [idx, m] of chunk.entries()) {
          if (!failed.has(idx)) continue;
          m.scheduleRetry(now, failed.get(idx));
          await this.store.scheduleRetry(publisherId, m);
          outboxFailures.inc();
        }
        succeeded.forEach((m) => m.markPublished(now));
        const marked = await this.store.markPublishedMany(publisherId, succeeded.map((m) => m.id), now);
        for (const m of succeeded) {
          if (!marked.has(m.id)) continue; // lease lost meanwhile: someone else owns the row now
          published++;
          outboxPublished.inc({ event_type: m.eventType });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ err: message, count: chunk.length }, 'outbox publish failed; scheduling retry');
        for (const m of chunk) {
          m.scheduleRetry(now, message);
          await this.store.scheduleRetry(publisherId, m).catch(() => undefined);
          outboxFailures.inc();
        }
      }
    }
    const { lag, pending } = await this.store.lagSeconds();
    outboxLag.set(lag);
    outboxPending.set(pending);
    return published;
  }
}

export function pendingReferenceTick(useCase: ProcessPendingReferencesUseCase) {
  return async () => {
    const result = await useCase.runOnce();
    if (result.resolved || result.rescheduled) logger.info({ ...result }, 'pending references processed');
  };
}
