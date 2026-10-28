import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config';
import { type EventContext, WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from '../domain/events';
import { FailureCode } from '../domain/failure-codes';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/ledger-entry';
import { OutboxMessage } from '../domain/outbox-message';
import { type WagerTransaction, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator, type TransactionalContext } from './ports';

export interface ProcessingContext {
  correlationId: string;
  causationId?: string;
}

/**
 * Decides and persists the outcome of a transaction *while the wallet row is locked*.
 * Shared by HTTP, SQS and the pending-reference worker so there is exactly one implementation
 * of the business rules.
 */
@Injectable()
export class TransactionProcessor {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * @param isNew true when `tx` has not been inserted yet (first evaluation).
   * Precondition: `wallet` was obtained through `wallets.lockById` in the current SQL transaction.
   */
  async evaluateAndPersist(
    ctx: TransactionalContext,
    wallet: Wallet,
    tx: WagerTransaction,
    isNew: boolean,
    pctx: ProcessingContext,
  ): Promise<{ entry?: WalletLedgerEntry }> {
    const now = this.clock.now();
    const versionBefore = wallet.version;
    const entry = await this.decide(ctx, wallet, tx, now);

    // Order matters: the ledger row has an FK to the transaction row.
    if (isNew) await ctx.transactions.insert(tx);
    else await ctx.transactions.update(tx);

    if (entry) {
      await ctx.wallets.updateBalance(wallet, versionBefore);
      await ctx.ledger.insert(entry);
    }

    await this.enqueueEvents(ctx, wallet, tx, entry, now, pctx);

    if (tx.status === WagerTransactionStatus.Processed) {
      // Anything parked waiting for this transaction can be retried right away.
      await ctx.transactions.expediteDependents(tx.walletId, tx.providerId, tx.externalTransactionId, now);
    }
    return { entry };
  }

  private async decide(ctx: TransactionalContext, wallet: Wallet, tx: WagerTransaction, now: Date): Promise<WalletLedgerEntry | undefined> {
    if (wallet.playerId !== tx.playerId) {
      tx.reject(FailureCode.WalletPlayerMismatch, now, wallet.balance);
      return undefined;
    }
    if (wallet.currency !== tx.money.currency) {
      tx.reject(FailureCode.CurrencyMismatch, now, wallet.balance);
      return undefined;
    }

    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId) {
      reference = await ctx.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
      if (!reference) {
        this.parkOrExpire(tx, now, wallet);
        return undefined;
      }
      const check = tx.checkReference(reference);
      if (check.kind === 'wait') {
        this.parkOrExpire(tx, now, wallet);
        return undefined;
      }
      if (check.kind === 'reject') {
        tx.reject(check.code, now, wallet.balance, reference.id);
        return undefined;
      }
      // Stricter than "per kind": a reference can be reverted once in total (REFUND xor ROLLBACK).
      // Backed by a partial unique index on reference_transaction_id. See ARCHITECTURE.md.
      if (tx.isReversal() && (await ctx.transactions.hasProcessedReversal(reference.id))) {
        tx.reject(FailureCode.ReferenceAlreadyReversed, now, wallet.balance, reference.id);
        return undefined;
      }
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, now, wallet.balance);
      return undefined;
    }

    const direction = tx.ledgerDirectionFor(reference);
    const movement = { entryId: this.ids.next(), transactionId: tx.id, money: tx.money, at: now };
    if (direction === LedgerDirection.Debit) {
      if (!wallet.canDebit(tx.money)) {
        const code = tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
        tx.reject(code, now, wallet.balance, reference?.id);
        return undefined;
      }
      const entry = wallet.debit(movement);
      tx.markProcessed(reference?.id, now, wallet.balance);
      return entry;
    }
    const entry = wallet.credit(movement);
    tx.markProcessed(reference?.id, now, wallet.balance);
    return entry;
  }

  private parkOrExpire(tx: WagerTransaction, now: Date, wallet: Wallet): void {
    const { maxAttempts, baseDelayMs, maxDelayMs } = this.config.pendingReference;
    if (tx.referenceAttempts >= maxAttempts) {
      tx.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
      return;
    }
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** tx.referenceAttempts);
    tx.markPendingReference(new Date(now.getTime() + delay), wallet.balance);
  }

  private async enqueueEvents(
    ctx: TransactionalContext,
    wallet: Wallet,
    tx: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    now: Date,
    pctx: ProcessingContext,
  ): Promise<void> {
    const eventCtx = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: pctx.correlationId,
      causationId: pctx.causationId ?? tx.id,
      occurredAt: now,
    });
    switch (tx.status) {
      case WagerTransactionStatus.Processed:
        await ctx.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, eventCtx())));
        if (entry) await ctx.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, eventCtx())));
        break;
      case WagerTransactionStatus.Rejected:
        await ctx.outbox.add(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, eventCtx())));
        break;
      case WagerTransactionStatus.PendingReference:
        // Announce only when the transaction is first parked, not on every re-check.
        if (tx.referenceAttempts === 1) {
          await ctx.outbox.add(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, eventCtx())));
        }
        break;
      default:
        break;
    }
  }
}
