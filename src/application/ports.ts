import type { InboxMessage } from '../domain/inbox-message';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Time-ordered UUID (v7) — keeps B-tree inserts append-mostly. */
  next(): string;
}

export interface WalletRepository {
  /** SELECT … FOR UPDATE on the wallet row: the per-wallet serialization point. */
  lockById(walletId: string, options?: { skipLocked?: boolean }): Promise<Wallet | undefined>;
  findById(walletId: string): Promise<Wallet | undefined>;
  /** Throws WalletAlreadyExistsError on (player_id, currency) unique violation. */
  insert(wallet: Wallet): Promise<void>;
  /** Conditional update `WHERE version = expectedVersion`; throws ConcurrencyConflictError on 0 rows. */
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** True if `referenceId` already has a PROCESSED reversal (REFUND/ROLLBACK). */
  hasProcessedReversal(referenceId: string): Promise<boolean>;
  /** Plain insert — unique violations surface as IdempotencyRaceError. */
  insert(tx: WagerTransaction): Promise<void>;
  /** Persists status-related fields of an existing row. */
  update(tx: WagerTransaction): Promise<void>;
  /**
   * Due PENDING_REFERENCE candidates (plain read, no lock). The worker then locks the *wallet*
   * first and re-reads the row, keeping the global lock order wallet → transaction.
   */
  findDuePendingReferences(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>>;
  /** Pulls forward the next check of PENDING_REFERENCE rows waiting for (provider, externalId) in the same wallet. */
  expediteDependents(walletId: string, providerId: string, externalTransactionId: string, now: Date): Promise<number>;
  countByStatus(): Promise<Record<string, number>>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined>;
  page(walletId: string, afterSequence: number | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  /** SUM(credits) − SUM(debits) and entry count, computed by the database. */
  aggregate(walletId: string): Promise<{ netMinor: bigint; entries: number; currency?: string }>;
}

export interface InboxRepository {
  /**
   * INSERT … ON CONFLICT DO NOTHING. Returns the existing row when it was already there.
   * Concurrent duplicates block on the unique index until the first tx finishes.
   */
  tryInsert(message: InboxMessage): Promise<{ inserted: true } | { inserted: false; existing: InboxMessage }>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
}

export interface TransactionalContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Runs `work` in one SQL transaction. Everything written through the context commits or
 * rolls back together — the atomicity boundary for wallet + ledger + transaction + inbox + outbox.
 */
export interface UnitOfWork {
  run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
  /** Read-only access outside an explicit transaction. */
  read<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
}

/** Authentication extension point (see ARCHITECTURE.md §Auth). */
export interface ProviderIdentityPort {
  /** Returns the providerId the caller is authenticated as, or undefined when auth is disabled. */
  resolve(request: { headers: Record<string, string | string[] | undefined> }): Promise<string | undefined>;
}
