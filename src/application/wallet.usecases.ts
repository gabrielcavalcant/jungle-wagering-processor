import { Inject, Injectable } from '@nestjs/common';
import { WalletBalanceChanged, WagerTransactionProcessed } from '../domain/events';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { canonicalJson, sha256 } from '../domain/payload-hash';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { ValidationError } from '../domain/errors';
import { TransactionNotFoundError, WalletNotFoundError } from './errors';
import { METRICS, type MetricsPort } from './metrics.port';
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator, UNIT_OF_WORK, type UnitOfWork } from './ports';

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /** Wallet + OPENING transaction + CREDIT entry + events in one SQL transaction. */
  async execute(cmd: { playerId: string; initialBalance: MoneyProps; correlationId: string }): Promise<Wallet> {
    const initial = Money.from(cmd.initialBalance);
    const now = this.clock.now();
    const wallet = Wallet.open({ id: this.ids.next(), playerId: cmd.playerId, currency: initial.currency, at: now });

    return this.uow.run(async (ctx) => {
      if (!initial.isPositive()) {
        await ctx.wallets.insert(wallet);
        return wallet;
      }
      const opening = WagerTransaction.createOpening({
        id: this.ids.next(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: initial,
        payloadHash: sha256(canonicalJson({ walletId: wallet.id, initialBalance: initial.toJSON() })),
        createdAt: now,
      });
      const entry = wallet.applyOpeningCredit({ entryId: this.ids.next(), transactionId: opening.id, money: initial, at: now });
      opening.markProcessed(undefined, now, wallet.balance);

      await ctx.wallets.insert(wallet); // unique (player_id, currency) → WalletAlreadyExistsError
      await ctx.transactions.insert(opening);
      await ctx.ledger.insert(entry);
      const ectx = () => ({ eventId: this.ids.next(), correlationId: cmd.correlationId, causationId: opening.id, occurredAt: now });
      await ctx.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ectx())));
      await ctx.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ectx())));
      return wallet;
    });
  }
}

export interface LedgerPage {
  items: WalletLedgerEntry[];
  nextCursor?: string;
}

@Injectable()
export class WalletQueries {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.read((ctx) => ctx.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }

  /**
   * Keyset pagination over the per-wallet ledger sequence. The cursor is opaque (base64url of
   * the last sequence) and stable: entries are append-only, so pages never shift.
   */
  async getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    const after = cursor ? decodeCursor(cursor) : undefined;
    return this.uow.read(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      const rows = await ctx.ledger.page(walletId, after, limit + 1);
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: rows.length > limit && last?.sequence !== undefined ? encodeCursor(last.sequence) : undefined,
      };
    });
  }

  async getTransaction(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((ctx) => ctx.transactions.findById(transactionId));
    if (!tx) throw new TransactionNotFoundError(transactionId);
    return tx;
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.uow.read((ctx) => ctx.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return tx;
  }
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  /**
   * Compares the materialized balance with the balance rebuilt from the ledger. Runs inside a
   * transaction holding the wallet lock so both reads see the same point in time.
   * Never corrects anything: a divergence is logged, counted and reported.
   */
  async execute(walletId: string): Promise<ReconciliationReport> {
    return this.uow.run(async (ctx) => {
      const wallet = await ctx.wallets.lockById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      const agg = await ctx.ledger.aggregate(walletId);
      const calculated = Money.ofMinor(agg.netMinor, wallet.currency);
      const difference = wallet.balance.subtract(calculated);
      const consistent = difference.isZero();
      if (!consistent) this.metrics.reconciliationDivergence(walletId);
      return {
        walletId,
        storedBalance: wallet.balance,
        calculatedBalance: calculated,
        difference,
        consistent,
        checkedEntries: agg.entries,
      };
    });
  }
}

function encodeCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ s: sequence }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof parsed.s === 'number' && Number.isSafeInteger(parsed.s) && parsed.s >= 0) return parsed.s;
  } catch {
    /* fallthrough */
  }
  throw new ValidationError('Invalid cursor');
}
