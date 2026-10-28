import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  IdempotencyRaceError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import type { FailureCode } from '../../domain/failure-codes';
import { InboxMessage } from '../../domain/inbox-message';
import { type LedgerDirection, WalletLedgerEntry } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import type { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { constraintOf, isUniqueViolation } from './db-errors';
import { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './entities';

type Row = Record<string, any>;

/**
 * Money mapping: numeric(20,2) columns come back as decimal strings ("975.00") and go in as
 * strings — no JS number is ever involved. Currency lives in its own char(3) column.
 */
const money = (amount: string, currency: string): Money => Money.parse({ amount, currency: currency.trim() });
const date = (v: unknown): Date | undefined => (v == null ? undefined : v instanceof Date ? v : new Date(String(v)));

/**
 * Reads never go through the identity map: inside one SQL transaction the same row is read
 * before and after taking the wallet lock, and the second read must see the latest commit.
 */
const FRESH = { disableIdentityMap: true } as const;

async function all(em: EntityManager, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await em.execute(sql, params, 'all')) as Row[];
}

async function run(em: EntityManager, sql: string, params: unknown[] = []): Promise<number> {
  const res = (await em.execute(sql, params, 'run')) as { affectedRows: number };
  return res.affectedRows;
}

// ---------------------------------------------------------------------------- wallets

function toWallet(r: WalletRecord): Wallet {
  const currency = r.currency.trim();
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency,
    balance: money(r.balance, currency),
    version: Number(r.version),
    createdAt: date(r.createdAt)!,
    updatedAt: date(r.updatedAt)!,
  });
}

export class SqlWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  /** SELECT … FOR UPDATE (or FOR UPDATE SKIP LOCKED) through MikroORM's LockMode. */
  async lockById(walletId: string, options?: { skipLocked?: boolean }): Promise<Wallet | undefined> {
    if (!isUuid(walletId)) return undefined;
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: options?.skipLocked ? LockMode.PESSIMISTIC_PARTIAL_WRITE : LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? toWallet(record) : undefined;
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    if (!isUuid(walletId)) return undefined;
    const record = await this.em.findOne(WalletRecord, { id: walletId }, FRESH);
    return record ? toWallet(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await run(
        this.em,
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        [wallet.id, wallet.playerId, wallet.currency, wallet.balance.amount, wallet.version, wallet.createdAt, wallet.updatedAt],
      );
    } catch (error) {
      if (isUniqueViolation(error, 'wallets_player_currency_uq')) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  /** Conditional write: defense in depth on top of the row lock. 0 rows ⇒ someone moved the version. */
  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await run(
      this.em,
      `update wallets set balance = ?, version = ?, updated_at = ? where id = ? and version = ?`,
      [wallet.balance.amount, wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (affected !== 1) throw new ConcurrencyConflictError(wallet.id);
  }
}

// ---------------------------------------------------------------------------- wager_transactions

function toTransaction(r: WagerTransactionRecord): WagerTransaction {
  const currency = r.currency.trim();
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash.trim(),
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, currency),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: date(r.createdAt)!,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode ?? undefined) as FailureCode | undefined,
    processedAt: date(r.processedAt),
    // result_balance is in the wallet currency (differs from `currency` on CURRENCY_MISMATCH rejections).
    resultBalance: r.resultBalance != null ? money(r.resultBalance, r.resultCurrency ?? currency) : undefined,
    referenceAttempts: Number(r.referenceAttempts),
    nextReferenceCheckAt: date(r.nextReferenceCheckAt),
  });
}

export class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    if (!isUuid(id)) return undefined;
    const r = await this.em.findOne(WagerTransactionRecord, { id }, FRESH);
    return r ? toTransaction(r) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { idempotencyKey: key }, FRESH);
    return r ? toTransaction(r) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, FRESH);
    return r ? toTransaction(r) : undefined;
  }

  async hasProcessedReversal(referenceId: string): Promise<boolean> {
    const n = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId: referenceId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return n > 0;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    try {
      await run(
        this.em,
        `insert into wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
           status, failure_code, result_balance, result_currency, reference_attempts, next_reference_check_at, processed_at,
           created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tx.id, tx.providerId, tx.externalTransactionId, tx.idempotencyKey, tx.payloadHash, tx.walletId, tx.playerId,
          tx.roundId, tx.gameId, tx.kind, tx.money.amount, tx.money.currency, tx.referenceExternalTransactionId ?? null,
          tx.referenceTransactionId ?? null, tx.status, tx.failureCode ?? null, tx.resultBalance?.amount ?? null,
          tx.resultBalance?.currency ?? null, tx.referenceAttempts, tx.nextReferenceCheckAt ?? null, tx.processedAt ?? null,
          tx.createdAt, new Date(),
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new IdempotencyRaceError(constraintOf(error) ?? 'unknown');
      throw error;
    }
  }

  async update(tx: WagerTransaction): Promise<void> {
    try {
      await run(
        this.em,
        `update wager_transactions
            set status = ?, failure_code = ?, result_balance = ?, result_currency = ?, reference_transaction_id = ?,
                reference_attempts = ?, next_reference_check_at = ?, processed_at = ?, updated_at = now()
          where id = ?`,
        [
          tx.status, tx.failureCode ?? null, tx.resultBalance?.amount ?? null, tx.resultBalance?.currency ?? null,
          tx.referenceTransactionId ?? null, tx.referenceAttempts, tx.nextReferenceCheckAt ?? null, tx.processedAt ?? null, tx.id,
        ],
      );
    } catch (error) {
      // wager_tx_single_reversal_uq: a concurrent reversal of the same reference committed first.
      if (isUniqueViolation(error)) throw new IdempotencyRaceError(constraintOf(error) ?? 'unknown');
      throw error;
    }
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceCheckAt: { $lte: now } },
      { ...FRESH, fields: ['id', 'walletId'], orderBy: { nextReferenceCheckAt: 'asc' }, limit },
    );
    return rows.map((r) => ({ id: r.id, walletId: r.walletId }));
  }

  async expediteDependents(walletId: string, providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return run(
      this.em,
      `update wager_transactions set next_reference_check_at = ?, updated_at = now()
        where status = 'PENDING_REFERENCE' and wallet_id = ? and provider_id = ?
          and reference_external_transaction_id = ? and next_reference_check_at > ?`,
      [now, walletId, providerId, externalTransactionId, now],
    );
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await all(this.em, `select status, count(*)::int as n from wager_transactions group by status`);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }
}

// ---------------------------------------------------------------------------- ledger

function toEntry(r: LedgerEntryRecord): WalletLedgerEntry {
  const currency = r.currency.trim();
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, currency),
    balanceBefore: money(r.balanceBefore, currency),
    balanceAfter: money(r.balanceAfter, currency),
    createdAt: date(r.createdAt)!,
    sequence: Number(r.sequence),
  });
}

export class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(e: WalletLedgerEntry): Promise<void> {
    await run(
      this.em,
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, e.walletId, e.transactionId, e.direction, e.money.amount, e.money.currency, e.balanceBefore.amount, e.balanceAfter.amount, e.createdAt],
    );
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined> {
    const r = await this.em.findOne(LedgerEntryRecord, { transactionId }, FRESH);
    return r ? toEntry(r) : undefined;
  }

  async page(walletId: string, afterSequence: number | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    const rows = await this.em.find(
      LedgerEntryRecord,
      { walletId, sequence: { $gt: String(afterSequence ?? 0) } },
      { ...FRESH, orderBy: { sequence: 'asc' }, limit },
    );
    return rows.map(toEntry);
  }

  /** Sum done in SQL numeric (exact), returned as text and converted to minor units without floats. */
  async aggregate(walletId: string): Promise<{ netMinor: bigint; entries: number; currency?: string }> {
    const rows = await all(
      this.em,
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(30,2)::text as net,
              count(*)::int as entries
         from wallet_ledger_entries where wallet_id = ?`,
      [walletId],
    );
    const r = rows[0]!;
    return { netMinor: Money.parse({ amount: String(r.net), currency: 'XXX' }).minorUnits, entries: Number(r.entries) };
  }
}

// ---------------------------------------------------------------------------- inbox

export class SqlInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(m: InboxMessage): Promise<{ inserted: true } | { inserted: false; existing: InboxMessage }> {
    const inserted = await all(
      this.em,
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?) on conflict (consumer_name, message_id) do nothing returning message_id`,
      [m.consumerName, m.messageId, m.payloadHash, m.receivedAt],
    );
    if (inserted.length > 0) return { inserted: true };
    const rows = await all(this.em, `select * from inbox_messages where consumer_name = ? and message_id = ?`, [
      m.consumerName,
      m.messageId,
    ]);
    const r = rows[0]!;
    return {
      inserted: false,
      existing: InboxMessage.rehydrate({
        messageId: r.message_id,
        consumerName: r.consumer_name,
        payloadHash: String(r.payload_hash).trim(),
        receivedAt: date(r.received_at)!,
        processedAt: date(r.processed_at),
      }),
    };
  }

  async markProcessed(m: InboxMessage): Promise<void> {
    await run(this.em, `update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`, [
      m.processedAt ?? new Date(),
      m.consumerName,
      m.messageId,
    ]);
  }
}

// ---------------------------------------------------------------------------- outbox

export class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(m: OutboxMessage): Promise<void> {
    await run(
      this.em,
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       values (?, ?, ?, ?::jsonb, ?, ?, ?)`,
      [m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt, m.attempts, m.nextAttemptAt ?? m.occurredAt],
    );
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}
