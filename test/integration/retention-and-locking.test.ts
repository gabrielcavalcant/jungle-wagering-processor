import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RecordPermanentFailureUseCase } from '../../src/application/record-permanent-failure.usecase';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.usecase';
import { TransactionProcessor } from '../../src/application/transaction-processor';
import { CreateWalletUseCase } from '../../src/application/wallet.usecases';
import { loadConfig } from '../../src/config';
import { RetentionStore } from '../../src/infrastructure/persistence/retention';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';
import { noopMetrics } from '../support/in-memory';
import { DB, assertGlobalInvariants, closeOrm, orm, resetDatabase, sql } from '../support/env';

const clock = { now: () => new Date() };
const ids = { next: () => Bun.randomUUIDv7() };
let uow: MikroOrmUnitOfWork;
let submit: SubmitWagerTransactionUseCase;
let createWallet: CreateWalletUseCase;

beforeAll(async () => {
  await resetDatabase();
  uow = new MikroOrmUnitOfWork(await orm(), DB);
  const config = loadConfig();
  config.pendingReference = { ...config.pendingReference, maxAttempts: 50 };
  submit = new SubmitWagerTransactionUseCase(uow, clock, ids, noopMetrics, new TransactionProcessor(clock, ids, config));
  createWallet = new CreateWalletUseCase(uow, clock, ids);
});

afterAll(async () => {
  await assertGlobalInvariants();
  await closeOrm();
});

async function newWallet(amount = '100.00') {
  const w = await createWallet.execute({ playerId: `p-${Bun.randomUUIDv7()}`, initialBalance: { amount, currency: 'BRL' }, correlationId: 'c' });
  return { walletId: w.id, playerId: w.playerId };
}

function cmd(w: { walletId: string; playerId: string }, ext: string, kind = 'BET', amount = '1.00', extra: Record<string, unknown> = {}) {
  return {
    idempotencyKey: `prov:${ext}`, providerId: 'prov', externalTransactionId: ext, playerId: w.playerId, walletId: w.walletId,
    roundId: 'r', gameId: 'g', kind: kind as never, money: { amount, currency: 'BRL' }, correlationId: 'c', source: 'sqs' as const, ...extra,
  };
}

describe('retention job', () => {
  test('deletes only old published outbox rows and old processed inbox rows; never pending ones or the ledger', async () => {
    const w = await newWallet();
    await submit.execute(cmd(w, 'ret-1'));
    const old = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    // Old published / old unpublished / recent published outbox rows.
    const ins = `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, published_at)
                 values (gen_random_uuid(), ?, 'X', '{}'::jsonb, ?, ?, ?)`;
    await sql(ins, [w.walletId, old, old, old]);
    await sql(ins, [w.walletId, old, old, old]);
    await sql(ins, [w.walletId, old, old, null]);
    await sql(ins, [w.walletId, old, old, new Date().toISOString()]);
    await sql(`insert into inbox_messages values ('c', 'old-done', repeat('a', 64), ?, ?)`, [old, old]);
    await sql(`insert into inbox_messages values ('c', 'old-unprocessed', repeat('a', 64), ?, null)`, [old]);
    await sql(`insert into inbox_messages values ('c', 'recent-done', repeat('a', 64), now(), now())`);
    const ledgerBefore = (await sql(`select count(*)::int as n from wallet_ledger_entries`))[0]!.n;

    const store = new RetentionStore(await orm(), { enabled: true, pollMs: 1000, batchSize: 1000, outboxHours: 24 * 7, inboxHours: 24 * 15 });
    const r = await store.purgeOnce();
    expect(r).toEqual({ outboxDeleted: 2, inboxDeleted: 1 });
    expect(await sql(`select 1 from outbox_messages where event_type = 'X'`)).toHaveLength(2);
    expect(await sql(`select 1 from outbox_messages where event_type = 'X' and published_at is null`)).toHaveLength(1);
    expect((await sql(`select message_id from inbox_messages where consumer_name = 'c' order by message_id`)).map((x) => x.message_id)).toEqual(['old-unprocessed', 'recent-done']);
    expect((await sql(`select count(*)::int as n from wallet_ledger_entries`))[0]!.n).toBe(ledgerBefore);
    expect(await store.purgeOnce()).toEqual({ outboxDeleted: 0, inboxDeleted: 0 });
  });

  test('batches: purges at most batchSize rows per run, and concurrent runs never delete the same row twice', async () => {
    const w = await newWallet();
    const old = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    await sql(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, published_at)
       select gen_random_uuid(), ?, 'BULK', '{}'::jsonb, ?, ?, ? from generate_series(1, 250)`,
      [w.walletId, old, old, old],
    );
    const store = new RetentionStore(await orm(), { enabled: true, pollMs: 1000, batchSize: 100, outboxHours: 24, inboxHours: 24 * 15 });
    const runs = await Promise.all([store.purgeOnce(), store.purgeOnce(), store.purgeOnce()]);
    expect(runs.every((x) => x.outboxDeleted <= 100)).toBe(true);
    const total = runs.reduce((a, x) => a + x.outboxDeleted, 0) + (await store.purgeOnce()).outboxDeleted + (await store.purgeOnce()).outboxDeleted;
    expect(total).toBe(250);
    expect(await sql(`select 1 from outbox_messages where event_type = 'BULK'`)).toHaveLength(0);
  });
});

describe('MikroORM LockMode on the wallet row', () => {
  test('PESSIMISTIC_WRITE blocks a second writer; PESSIMISTIC_PARTIAL_WRITE (SKIP LOCKED) skips the busy wallet', async () => {
    const w = await newWallet();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = uow.run(async (ctx) => {
      expect(await ctx.wallets.lockById(w.walletId)).toBeDefined();
      locked();
      await held;
    });
    await isLocked;
    // SKIP LOCKED: returns immediately with nothing.
    const skipped = await uow.run((ctx) => ctx.wallets.lockById(w.walletId, { skipLocked: true }));
    expect(skipped).toBeUndefined();
    // FOR UPDATE: waits until the holder commits.
    let acquiredAt = 0;
    const waiter = uow.run(async (ctx) => {
      await ctx.wallets.lockById(w.walletId);
      acquiredAt = Date.now();
    });
    await Bun.sleep(300);
    expect(acquiredAt).toBe(0);
    const releasedAt = Date.now();
    release();
    await Promise.all([holder, waiter]);
    expect(acquiredAt).toBeGreaterThanOrEqual(releasedAt);
  });
});

describe('FAILED status', () => {
  test('a PENDING_REFERENCE transaction that exhausted infrastructure retries becomes FAILED (terminal)', async () => {
    const w = await newWallet();
    const parked = await submit.execute(cmd(w, 'fail-rf', 'REFUND', '5.00', { referenceExternalTransactionId: 'missing-bet' }));
    expect(parked.transaction.status).toBe('PENDING_REFERENCE' as never);
    const recorder = new RecordPermanentFailureUseCase(uow, clock, ids, noopMetrics);
    const failed = await recorder.execute(cmd(w, 'fail-rf', 'REFUND', '5.00', { referenceExternalTransactionId: 'missing-bet' }), 'db down');
    expect(failed!.status).toBe('FAILED' as never);
    const row = (await sql(`select status, failure_code from wager_transactions where id = ?`, [parked.transaction.id]))[0];
    expect(row).toEqual({ status: 'FAILED', failure_code: 'PERMANENT_INFRASTRUCTURE_FAILURE' });
    // Terminal: the pending-reference worker will not pick it up anymore, and the DB refuses changes.
    expect(await sql(`select 1 from wager_transactions where id = ? and status = 'PENDING_REFERENCE'`, [parked.transaction.id])).toHaveLength(0);
  });

  test('an already terminal transaction is left untouched', async () => {
    const w = await newWallet();
    const ok = await submit.execute(cmd(w, 'fail-ok'));
    const recorder = new RecordPermanentFailureUseCase(uow, clock, ids, noopMetrics);
    const result = await recorder.execute(cmd(w, 'fail-ok'), 'late');
    expect(result!.status).toBe('PROCESSED' as never);
    expect((await sql(`select status from wager_transactions where id = ?`, [ok.transaction.id]))[0]!.status).toBe('PROCESSED');
  });
});
