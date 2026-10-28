import { Inject, Injectable } from '@nestjs/common';
import { InboxMessage } from '../domain/inbox-message';
import { Money, type MoneyProps } from '../domain/money';
import { hashWagerPayload } from '../domain/payload-hash';
import { WagerTransaction, type WagerTransactionKind } from '../domain/wager-transaction';
import {
  ConcurrencyConflictError,
  ExternalIdConflictError,
  IdempotencyConflictError,
  IdempotencyRaceError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from './errors';
import { METRICS, type MetricsPort } from './metrics.port';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator, type TransactionalContext, UNIT_OF_WORK, type UnitOfWork } from './ports';
import { TransactionProcessor } from './transaction-processor';

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  source: 'http' | 'sqs';
  /** Present when the command comes from the queue: dedup record written in the same SQL tx. */
  inbox?: { messageId: string; consumerName: string; payloadHash: string };
}

export interface SubmitWagerTransactionResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
  /** True when the SQS message itself was already handled (inbox hit). */
  duplicateMessage: boolean;
}

const MAX_ATTEMPTS = 4;

@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly processor: TransactionProcessor,
  ) {}

  async execute(cmd: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const startedAt = performance.now();
    // Validation happens before touching the database. Money.from rejects NaN/exponent/>2 decimals/negatives.
    const money = Money.from(cmd.money);
    const payloadHash = hashWagerPayload({ ...cmd, money: money.toJSON() });
    // A fresh aggregate per attempt: a rolled-back attempt may have mutated the previous one.
    const newCandidate = () => WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind,
      money,
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
    newCandidate(); // validate eagerly, before any I/O

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.uow.run((ctx) => this.attempt(ctx, cmd, newCandidate(), payloadHash));
        this.metrics.processingLatency(cmd.source, (performance.now() - startedAt) / 1000);
        if (result.duplicateMessage) this.metrics.duplicateDetected('inbox_message');
        else if (result.idempotentReplay) this.metrics.duplicateDetected('idempotency_replay');
        else this.metrics.transactionFinalized(result.transaction.status, result.transaction.kind, cmd.source);
        return result;
      } catch (error) {
        // A concurrent insert of the same key/message won the race: loop, re-read, and replay its outcome.
        const retryable =
          error instanceof IdempotencyRaceError ||
          error instanceof ConcurrencyConflictError ||
          (error instanceof TransientInfrastructureError && attempt < MAX_ATTEMPTS);
        if (error instanceof IdempotencyConflictError) this.metrics.duplicateDetected('idempotency_conflict');
        if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
        this.metrics.retry('submit_wager_transaction', (error as Error).constructor.name);
        if (error instanceof ConcurrencyConflictError) this.metrics.lockConflict('version_mismatch');
        await sleep(Math.floor(Math.random() * 20 * attempt));
      }
    }
  }

  private async attempt(
    ctx: TransactionalContext,
    cmd: SubmitWagerTransactionCommand,
    candidate: WagerTransaction,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult> {
    let inbox: InboxMessage | undefined;
    if (cmd.inbox) {
      inbox = InboxMessage.receive({ ...cmd.inbox, receivedAt: this.clock.now() });
      const outcome = await ctx.inbox.tryInsert(inbox);
      if (!outcome.inserted) {
        // Message already handled in a committed tx: return what it produced, write nothing.
        const original = await ctx.transactions.findByIdempotencyKey(cmd.idempotencyKey);
        if (original && original.matchesPayload(payloadHash)) {
          return { transaction: original, idempotentReplay: true, duplicateMessage: true };
        }
        if (original) throw new IdempotencyConflictError(cmd.idempotencyKey, original.id);
        // Inbox row without a transaction (e.g. wallet not found earlier): treat like a fresh attempt below.
        inbox = outcome.existing;
      }
    }

    // Fast path, no lock: terminal transactions are immutable, so a replay needs no serialization.
    // Keeps 50 parallel duplicates from queueing on the hot wallet's row lock.
    const early = await ctx.transactions.findByIdempotencyKey(cmd.idempotencyKey);
    if (early?.isTerminal()) {
      return this.replay(ctx, early, payloadHash, inbox);
    }

    // Serialization point: all writers of this wallet queue here (SELECT … FOR UPDATE).
    const wallet = await ctx.wallets.lockById(cmd.walletId);
    if (!wallet) throw new WalletNotFoundError(cmd.walletId);

    // Re-read under the lock (READ COMMITTED: each statement sees the latest committed data).
    const existing = await ctx.transactions.findByIdempotencyKey(cmd.idempotencyKey);
    if (existing) return this.replay(ctx, existing, payloadHash, inbox);

    const sameExternal = await ctx.transactions.findByExternalId(cmd.providerId, cmd.externalTransactionId);
    if (sameExternal) throw new ExternalIdConflictError(cmd.providerId, cmd.externalTransactionId);

    await this.processor.evaluateAndPersist(ctx, wallet, candidate, true, {
      correlationId: cmd.correlationId,
      causationId: cmd.inbox?.messageId,
    });
    if (inbox) {
      inbox.markProcessed(this.clock.now());
      await ctx.inbox.markProcessed(inbox);
    }
    return { transaction: candidate, idempotentReplay: false, duplicateMessage: false };
  }

  private async replay(
    ctx: TransactionalContext,
    existing: WagerTransaction,
    payloadHash: string,
    inbox: InboxMessage | undefined,
  ): Promise<SubmitWagerTransactionResult> {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(existing.idempotencyKey, existing.id);
    }
    if (inbox) {
      inbox.markProcessed(this.clock.now());
      await ctx.inbox.markProcessed(inbox);
    }
    return { transaction: existing, idempotentReplay: true, duplicateMessage: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
