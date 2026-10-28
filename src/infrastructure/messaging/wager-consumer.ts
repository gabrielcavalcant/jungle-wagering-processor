import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { ExternalIdConflictError, IdempotencyConflictError, ProviderForbiddenError, WalletNotFoundError } from '../../application/errors';
import type { SubmitWagerTransactionUseCase } from '../../application/submit-wager-transaction.usecase';
import type { AppConfig } from '../../config';
import { ValidationError } from '../../domain/errors';
import { sha256 } from '../../domain/payload-hash';
import type { WagerTransactionKind } from '../../domain/wager-transaction';
import { logger } from '../observability/logger';
import { dlqMessages, sqsMessages } from '../observability/metrics';
import type { SqsGateway } from './sqs';
import { wagerMessageSchema } from './wager-message.schema';

/** How a message is settled. */
export type Disposition =
  | { kind: 'ack'; outcome: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'dlq'; reason: string };

/**
 * SQS consumer for wager-transactions.fifo.
 * - business outcomes (PROCESSED / REJECTED / PENDING_REFERENCE / replay) → ack after commit;
 * - transient errors (DB down, lock timeout) → visibility backoff, retried by SQS;
 * - permanent errors (bad payload, idempotency conflict, unknown wallet) → DLQ immediately;
 * - receiveCount reaching the limit → DLQ (the queue's redrive policy is the backstop).
 * Within a batch, messages of the same MessageGroupId run sequentially, groups run in parallel.
 */
export class WagerConsumer {
  private running = false;
  private loop?: Promise<void>;
  private abort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly sqs: SqsGateway,
    private readonly useCase: SubmitWagerTransactionUseCase,
    private readonly config: AppConfig,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.poll();
    logger.info({ queue: this.config.sqs.inputQueue }, 'sqs consumer started');
  }

  /** SIGTERM path: stop receiving, finish in-flight messages, release the ones not started. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    await this.loop?.catch(() => undefined);
    await Promise.allSettled([...this.inFlight]);
    logger.info('sqs consumer stopped');
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const url = await this.sqs.inputQueueUrl();
        const res = await this.sqs.client.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: this.config.sqs.batchSize,
            WaitTimeSeconds: this.config.sqs.waitTimeSec,
            VisibilityTimeout: this.config.sqs.visibilityTimeoutSec,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        const messages = res.Messages ?? [];
        if (messages.length === 0) continue;
        const batch = this.processBatch(url, messages);
        this.inFlight.add(batch);
        await batch.finally(() => this.inFlight.delete(batch));
      } catch (error) {
        if (!this.running) break;
        logger.warn({ err: errMessage(error) }, 'sqs receive failed; backing off');
        await sleep(1_000);
      }
    }
  }

  private async processBatch(queueUrl: string, messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const group = m.Attributes?.MessageGroupId ?? m.MessageId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (groupMessages) => {
        for (const message of groupMessages) {
          if (!this.running) {
            // Not started yet: hand it back immediately instead of waiting for the visibility timeout.
            await this.release(queueUrl, message, 0);
            continue;
          }
          await this.settle(queueUrl, message, await this.handle(message));
        }
      }),
    );
  }

  /** Pure decision: runs the use case and classifies the result. Exposed for tests. */
  async handle(message: Message): Promise<Disposition> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(message.Body ?? '');
    } catch {
      return { kind: 'dlq', reason: 'invalid_json' };
    }
    const parsed = wagerMessageSchema.safeParse(parsedBody);
    if (!parsed.success) return { kind: 'dlq', reason: 'invalid_schema' };

    const { messageId, data } = parsed.data;
    const correlationId = parsed.data.correlationId ?? messageId;
    const log = { correlationId, messageId, providerId: data.providerId, walletId: data.walletId };
    try {
      const result = await this.useCase.execute({
        ...data,
        kind: data.kind as WagerTransactionKind,
        correlationId,
        source: 'sqs',
        inbox: { messageId, consumerName: this.config.sqs.consumerName, payloadHash: sha256(message.Body ?? '') },
      });
      const tx = result.transaction;
      logger.info(
        { ...log, transactionId: tx.id, status: tx.status, failureCode: tx.failureCode, replay: result.idempotentReplay, duplicateMessage: result.duplicateMessage },
        'wager message handled',
      );
      if (this.config.faultInjection === 'after-commit-before-ack') {
        logger.warn(log, 'FAULT INJECTION: exiting after commit, before ack');
        process.exit(137);
      }
      return { kind: 'ack', outcome: result.duplicateMessage ? 'duplicate' : tx.status.toLowerCase() };
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof IdempotencyConflictError ||
        error instanceof ExternalIdConflictError ||
        error instanceof WalletNotFoundError ||
        error instanceof ProviderForbiddenError
      ) {
        logger.warn({ ...log, code: error.code }, 'permanent message error');
        return { kind: 'dlq', reason: error.code.toLowerCase() };
      }
      logger.error({ ...log, err: errMessage(error), receiveCount }, 'transient message error');
      if (receiveCount >= this.config.sqs.maxReceiveCount) return { kind: 'dlq', reason: 'max_receive_count' };
      return { kind: 'retry', reason: (error as Error)?.constructor?.name ?? 'unknown' };
    }
  }

  private async settle(queueUrl: string, message: Message, d: Disposition): Promise<void> {
    try {
      if (d.kind === 'ack') {
        await this.delete(queueUrl, message);
        sqsMessages.inc({ outcome: d.outcome });
      } else if (d.kind === 'dlq') {
        await this.sendToDlq(message, d.reason);
        await this.delete(queueUrl, message);
        dlqMessages.inc({ reason: d.reason });
        sqsMessages.inc({ outcome: 'dlq' });
      } else {
        const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
        const delay = Math.min(300, this.config.sqs.retryBaseDelaySec * 2 ** (receiveCount - 1));
        await this.release(queueUrl, message, delay);
        sqsMessages.inc({ outcome: 'retry' });
      }
    } catch (error) {
      // Failing to settle is safe: the message reappears after the visibility timeout and the inbox dedups it.
      logger.error({ messageId: message.MessageId, err: errMessage(error) }, 'failed to settle sqs message');
    }
  }

  private async delete(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async release(queueUrl: string, message: Message, delaySec: number): Promise<void> {
    await this.sqs.client
      .send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: delaySec }))
      .catch((error) => logger.warn({ messageId: message.MessageId, err: errMessage(error) }, 'failed to change visibility'));
  }

  private async sendToDlq(message: Message, reason: string): Promise<void> {
    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: await this.sqs.dlqUrl(),
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: sha256(`${message.MessageId}:${reason}`).slice(0, 64),
        MessageAttributes: {
          dlqReason: { DataType: 'String', StringValue: reason },
          originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
        },
      }),
    );
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
