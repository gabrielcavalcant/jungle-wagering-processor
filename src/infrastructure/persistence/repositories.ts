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

type Row = Record<string, any>;

/**
 * Money mapping: numeric(20,2) columns come back from `pg` as decimal strings ("975.00") and go
 * in as strings — no JS number is ever involved. Currency lives in its own char(3) column.
 */
const money = (amount: string, currency: string): Money => Money.parse({ amount, currency: currency.trim() });
const date = (v: unknown): Date | undefined => (v == null ? undefined : v instanceof Date ? v : new Date(String(v)));

async function all(em: EntityManager, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await em.execute(sql, params, 'all')) as Row[];
}

async function run(em: EntityManager, sql: string, params: unknown[] = []): Promise<number> {
  const res = (await em.execute(sql, params, 'run')) as { affectedRows: number };
  return res.affectedRows;
}

// ---------------------------------------------------------------------------- wallets

function toWallet(r: Row): Wallet {
  const currency = String(r.currency).trim();
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.player_id,
    currency,
    balance: money(r.balance, currency),
    version: Number(r.version),
    createdAt: date(r.created_at)!,
    updatedAt: date(r.updated_at)!,
  });
}

export class SqlWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(walletId: string, options?: { skipLocked?: boolean }): Promise<Wallet | undefined> {
    if (!isUuid(walletId)) return undefined;
    const suffix = options?.skipLocked ? 'for update skip locked' : 'for update';
    const rows = await all(this.em, `select * from wallets where id = ? ${suffix}`, [walletId]);
    return rows[0] ? toWallet(rows[0]) : undefined;
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    if (!isUuid(walletId)) return undefined;
    const rows = await all(this.em, 'select * from wallets where id = ?', [walletId]);
    return rows[0] ? toWallet(rows[0]) : undefined;
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

function toTransaction(r: Row): WagerTransaction {
  const currency = String(r.currency).trim();
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.provider_id,
    externalTransactionId: r.external_transaction_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: String(r.payload_hash).trim(),
    walletId: r.wallet_id,
    playerId: r.player_id,
    roundId: r.round_id,
    gameId: r.game_id,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, currency),
    referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
    createdAt: date(r.created_at)!,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.reference_transaction_id ?? undefined,
    failureCode: (r.failure_code ?? undefined) as FailureCode | undefined,
    processedAt: date(r.processed_at),
    // result_balance is in the wallet currency; on CURRENCY_MISMATCH rejections it is read with the wallet's.
    resultBalance: r.result_balance != null ? money(r.result_balance, String(r.wallet_currency ?? currency).trim()) : undefined,
    referenceAttempts: Number(r.reference_attempts),
    nextReferenceCheckAt: date(r.next_reference_check_at),
  });
}

const TX_SELECT = `select t.*, w.currency as wallet_currency from wager_transactions t join wallets w on w.id = t.wallet_id`;

export class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    if (!isUuid(id)) return undefined;
    const rows = await all(this.em, `${TX_SELECT} where t.id = ?`, [id]);
    return rows[0] ? toTransaction(rows[0]) : undefined;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    const rows = await all(this.em, `${TX_SELECT} where t.idempotency_key = ?`, [key]);
    return rows[0] ? toTransaction(rows[0]) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const rows = await all(this.em, `${TX_SELECT} where t.provider_id = ? and t.external_transaction_id = ?`, [
      providerId,
      externalTransactionId,
    ]);
    return rows[0] ? toTransaction(rows[0]) : undefined;
  }

  async hasProcessedReversal(referenceId: string): Promise<boolean> {
    const rows = await all(
      this.em,
      `select 1 from wager_transactions
        where reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND','ROLLBACK') limit 1`,
      [referenceId],
    );
    return rows.length > 0;
  }

  async insert(tx: WagerTransaction): Promise<void> {
    try {
      await run(
        this.em,
        `insert into wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
           status, failure_code, result_balance, reference_attempts, next_reference_check_at, processed_at,
           created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tx.id, tx.providerId, tx.externalTransactionId, tx.idempotencyKey, tx.payloadHash, tx.walletId, tx.playerId,
          tx.roundId, tx.gameId, tx.kind, tx.money.amount, tx.money.currency, tx.referenceExternalTransactionId ?? null,
          tx.referenceTransactionId ?? null, tx.status, tx.failureCode ?? null, tx.resultBalance?.amount ?? null,
          tx.referenceAttempts, tx.nextReferenceCheckAt ?? null, tx.processedAt ?? null, tx.createdAt, new Date(),
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
            set status = ?, failure_code = ?, result_balance = ?, reference_transaction_id = ?,
                reference_attempts = ?, next_reference_check_at = ?, processed_at = ?, updated_at = now()
          where id = ?`,
        [
          tx.status, tx.failureCode ?? null, tx.resultBalance?.amount ?? null, tx.referenceTransactionId ?? null,
          tx.referenceAttempts, tx.nextReferenceCheckAt ?? null, tx.processedAt ?? null, tx.id,
        ],
      );
    } catch (error) {
      // wager_tx_single_reversal_uq: a concurrent reversal of the same reference committed first.
      if (isUniqueViolation(error)) throw new IdempotencyRaceError(constraintOf(error) ?? 'unknown');
      throw error;
    }
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    const rows = await all(
      this.em,
      `select id, wallet_id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_reference_check_at <= ?
        order by next_reference_check_at limit ?`,
      [now, limit],
    );
    return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
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

function toEntry(r: Row): WalletLedgerEntry {
  const currency = String(r.currency).trim();
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.wallet_id,
    transactionId: r.transaction_id,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, currency),
    balanceBefore: money(r.balance_before, currency),
    balanceAfter: money(r.balance_after, currency),
    createdAt: date(r.created_at)!,
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
    const rows = await all(this.em, 'select * from wallet_ledger_entries where transaction_id = ? limit 1', [transactionId]);
    return rows[0] ? toEntry(rows[0]) : undefined;
  }

  async page(walletId: string, afterSequence: number | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    const rows = await all(
      this.em,
      `select * from wallet_ledger_entries where wallet_id = ? and sequence > ? order by sequence asc limit ?`,
      [walletId, afterSequence ?? 0, limit],
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
