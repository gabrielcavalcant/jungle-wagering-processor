import { Inject, Injectable } from '@nestjs/common';
import { WagerTransactionFailed } from '../domain/events';
import { FailureCode } from '../domain/failure-codes';
import { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { hashWagerPayload } from '../domain/payload-hash';
import { WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import { IdempotencyRaceError } from './errors';
import { METRICS, type MetricsPort } from './metrics.port';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator, UNIT_OF_WORK, type UnitOfWork } from './ports';
import type { SubmitWagerTransactionCommand } from './submit-wager-transaction.usecase';

/**
 * Called when a message exhausted its retries on *infrastructure* errors and goes to the DLQ.
 * Leaves an auditable FAILED transaction (status terminal, failure code
 * PERMANENT_INFRASTRUCTURE_FAILURE, no balance movement, no ledger entry) plus a
 * WagerTransactionFailed event, so the provider learns the outcome instead of waiting forever.
 *
 * - already terminal → nothing to do (e.g. the commit succeeded but the ack kept failing);
 * - PENDING_REFERENCE → moved to FAILED;
 * - not persisted yet → inserted directly as FAILED;
 * - wallet unknown → nothing can be recorded (FK), the DLQ message is the audit trail.
 * Best effort: when the database itself is what is down, this fails too and only the DLQ remains.
 */
@Injectable()
export class RecordPermanentFailureUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  async execute(cmd: Omit<SubmitWagerTransactionCommand, 'inbox'>, reason: string): Promise<WagerTransaction | undefined> {
    const money = Money.from(cmd.money);
    const payloadHash = hashWagerPayload({ ...cmd, money: money.toJSON() });
    try {
      const result = await this.uow.run(async (ctx) => {
        const wallet = await ctx.wallets.lockById(cmd.walletId);
        if (!wallet) return undefined;
        const now = this.clock.now();
        const existing = await ctx.transactions.findByIdempotencyKey(cmd.idempotencyKey);
        let tx: WagerTransaction;
        if (existing) {
          if (existing.isTerminal() || !existing.matchesPayload(payloadHash)) return existing;
          existing.fail(FailureCode.PermanentInfrastructureFailure, now, wallet.balance);
          await ctx.transactions.update(existing);
          tx = existing;
        } else {
          tx = WagerTransaction.create({
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
            createdAt: now,
          });
          tx.fail(FailureCode.PermanentInfrastructureFailure, now, wallet.balance);
          await ctx.transactions.insert(tx);
        }
        await ctx.outbox.add(
          OutboxMessage.enqueue(
            WagerTransactionFailed.from(tx, reason, { eventId: this.ids.next(), correlationId: cmd.correlationId, causationId: tx.id, occurredAt: now }),
          ),
        );
        return tx;
      });
      if (result?.status === WagerTransactionStatus.Failed) this.metrics.transactionFinalized(result.status, result.kind, cmd.source);
      return result;
    } catch (error) {
      // Same (provider, external id) under another key: the existing row is the record of truth.
      if (error instanceof IdempotencyRaceError) return undefined;
      throw error;
    }
  }
}
