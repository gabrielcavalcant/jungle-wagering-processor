import { IdempotencyRaceError, WalletAlreadyExistsError } from '../../src/application/errors';
import type { MetricsPort } from '../../src/application/metrics.port';
import type { TransactionalContext, UnitOfWork } from '../../src/application/ports';
import { ProcessPendingReferencesUseCase } from '../../src/application/process-pending-references.usecase';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.usecase';
import { TransactionProcessor } from '../../src/application/transaction-processor';
import { CreateWalletUseCase, ReconcileWalletUseCase } from '../../src/application/wallet.usecases';
import { type AppConfig, loadConfig } from '../../src/config';
import { InboxMessage } from '../../src/domain/inbox-message';
import { WalletLedgerEntry } from '../../src/domain/ledger-entry';
import type { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';

/**
 * In-memory adapters for *unit* tests of the business rules only. Snapshot/restore emulates
 * rollback. Concurrency, constraints and atomicity are tested against real PostgreSQL elsewhere.
 */
class Store {
  wallets = new Map<string, Wallet>();
  txs = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  inbox = new Map<string, InboxMessage>();
  outbox: OutboxMessage[] = [];

  snapshot() {
    const clone = <T extends object>(o: T): T => Object.assign(Object.create(Object.getPrototypeOf(o)), o);
    return {
      wallets: new Map([...this.wallets].map(([k, v]) => [k, clone(v)])),
      txs: new Map([...this.txs].map(([k, v]) => [k, clone(v)])),
      ledger: [...this.ledger],
      inbox: new Map([...this.inbox].map(([k, v]) => [k, clone(v)])),
      outbox: [...this.outbox],
    };
  }
  restore(s: ReturnType<Store['snapshot']>) {
    Object.assign(this, s);
  }
}

const clone = <T extends object>(o: T): T => Object.assign(Object.create(Object.getPrototypeOf(o)), o);

function ctxFor(s: Store): TransactionalContext {
  return {
    wallets: {
      lockById: async (id) => (s.wallets.has(id) ? clone(s.wallets.get(id)!) : undefined),
      findById: async (id) => (s.wallets.has(id) ? clone(s.wallets.get(id)!) : undefined),
      insert: async (w) => {
        for (const x of s.wallets.values()) if (x.playerId === w.playerId && x.currency === w.currency) throw new WalletAlreadyExistsError(w.playerId, w.currency);
        s.wallets.set(w.id, clone(w));
      },
      updateBalance: async (w) => void s.wallets.set(w.id, clone(w)),
    },
    transactions: {
      findById: async (id) => (s.txs.has(id) ? clone(s.txs.get(id)!) : undefined),
      findByIdempotencyKey: async (k) => {
        const t = [...s.txs.values()].find((x) => x.idempotencyKey === k);
        return t ? clone(t) : undefined;
      },
      findByExternalId: async (p, e) => {
        const t = [...s.txs.values()].find((x) => x.providerId === p && x.externalTransactionId === e);
        return t ? clone(t) : undefined;
      },
      hasProcessedReversal: async (refId) =>
        [...s.txs.values()].some((x) => x.referenceTransactionId === refId && x.status === WagerTransactionStatus.Processed && x.isReversal()),
      insert: async (t) => {
        for (const x of s.txs.values()) {
          if (x.idempotencyKey === t.idempotencyKey) throw new IdempotencyRaceError('wager_tx_idempotency_key_uq');
          if (x.providerId === t.providerId && x.externalTransactionId === t.externalTransactionId) throw new IdempotencyRaceError('wager_tx_provider_external_uq');
        }
        s.txs.set(t.id, clone(t));
      },
      update: async (t) => void s.txs.set(t.id, clone(t)),
      findDuePendingReferences: async (now, limit) =>
        [...s.txs.values()]
          .filter((t) => t.status === WagerTransactionStatus.PendingReference && t.nextReferenceCheckAt!.getTime() <= now.getTime())
          .slice(0, limit)
          .map((t) => ({ id: t.id, walletId: t.walletId })),
      expediteDependents: async () => 0,
      countByStatus: async () => ({}),
    },
    ledger: {
      insert: async (e) => void s.ledger.push(e),
      findByTransactionId: async (id) => s.ledger.find((e) => e.transactionId === id),
      page: async (w) => s.ledger.filter((e) => e.walletId === w),
      aggregate: async (w) => {
        const es = s.ledger.filter((e) => e.walletId === w);
        return { netMinor: es.reduce((acc, e) => acc + e.signedAmount().minorUnits, 0n), entries: es.length };
      },
    },
    inbox: {
      tryInsert: async (m) => {
        const key = `${m.consumerName}:${m.messageId}`;
        const existing = s.inbox.get(key);
        if (existing) return { inserted: false, existing };
        s.inbox.set(key, m);
        return { inserted: true };
      },
      markProcessed: async (m) => void s.inbox.set(`${m.consumerName}:${m.messageId}`, m),
    },
    outbox: { add: async (m) => void s.outbox.push(m) },
  };
}

export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(readonly store = new Store()) {}
  async run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    const snap = this.store.snapshot();
    try {
      return await work(ctxFor(this.store));
    } catch (e) {
      this.store.restore(snap);
      throw e;
    }
  }
  async read<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return work(ctxFor(this.store));
  }
}

export const noopMetrics: MetricsPort = {
  transactionFinalized() {},
  duplicateDetected() {},
  retry() {},
  lockConflict() {},
  processingLatency() {},
  reconciliationDivergence() {},
};

export class FakeClock {
  constructor(public current = new Date('2026-07-29T15:00:00.000Z')) {}
  now() {
    return new Date(this.current);
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function buildInMemory(overrides: Partial<AppConfig['pendingReference']> = {}) {
  const config = loadConfig();
  config.pendingReference = { ...config.pendingReference, baseDelayMs: 1000, maxAttempts: 3, ...overrides };
  const uow = new InMemoryUnitOfWork();
  const clock = new FakeClock();
  let n = 0;
  const ids = { next: () => `00000000-0000-7000-8000-${String(++n).padStart(12, '0')}` };
  const processor = new TransactionProcessor(clock, ids, config);
  return {
    uow,
    clock,
    store: uow.store,
    submit: new SubmitWagerTransactionUseCase(uow, clock, ids, noopMetrics, processor),
    createWallet: new CreateWalletUseCase(uow, clock, ids),
    reconcile: new ReconcileWalletUseCase(uow, noopMetrics),
    pending: new ProcessPendingReferencesUseCase(uow, clock, noopMetrics, processor),
  };
}

export { WagerTransactionKind as Kind, WagerTransactionStatus as Status };
