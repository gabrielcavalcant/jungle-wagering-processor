import { Inject, Injectable } from '@nestjs/common';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { METRICS, type MetricsPort } from './metrics.port';
import { CLOCK, type Clock, UNIT_OF_WORK, type UnitOfWork } from './ports';
import { TransactionProcessor } from './transaction-processor';

export interface PendingReferenceRunResult {
  scanned: number;
  resolved: number;
  rescheduled: number;
  skipped: number;
}

/**
 * Re-evaluates due PENDING_REFERENCE transactions. Safe with N instances:
 * - candidates are read without locks;
 * - each one is handled in its own SQL tx that locks the wallet with SKIP LOCKED
 *   (busy wallet → skip, someone else is on it or it's being written right now);
 * - the row is re-read under the lock and skipped if no longer due.
 */
@Injectable()
export class ProcessPendingReferencesUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    private readonly processor: TransactionProcessor,
  ) {}

  async runOnce(limit = 50): Promise<PendingReferenceRunResult> {
    const result: PendingReferenceRunResult = { scanned: 0, resolved: 0, rescheduled: 0, skipped: 0 };
    const candidates = await this.uow.read((ctx) => ctx.transactions.findDuePendingReferences(this.clock.now(), limit));
    result.scanned = candidates.length;

    for (const candidate of candidates) {
      const outcome = await this.uow.run(async (ctx) => {
        const wallet = await ctx.wallets.lockById(candidate.walletId, { skipLocked: true });
        if (!wallet) return 'skipped' as const;
        const tx = await ctx.transactions.findById(candidate.id);
        const now = this.clock.now();
        if (
          !tx ||
          tx.status !== WagerTransactionStatus.PendingReference ||
          (tx.nextReferenceCheckAt && tx.nextReferenceCheckAt.getTime() > now.getTime())
        ) {
          return 'skipped' as const;
        }
        await this.processor.evaluateAndPersist(ctx, wallet, tx, false, {
          correlationId: tx.id,
          causationId: tx.id,
        });
        if (tx.status === WagerTransactionStatus.PendingReference) return 'rescheduled' as const;
        this.metrics.transactionFinalized(tx.status, tx.kind, 'pending_reference_worker');
        return 'resolved' as const;
      });
      result[outcome] += 1;
      if (outcome === 'rescheduled') this.metrics.retry('pending_reference', 'reference_missing');
      if (outcome === 'skipped') this.metrics.lockConflict('pending_reference_wallet_busy');
    }
    return result;
  }
}
