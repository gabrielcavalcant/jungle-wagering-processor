import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { TransactionalContext } from '../../src/application/ports';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.usecase';
import { TransactionProcessor } from '../../src/application/transaction-processor';
import { CreateWalletUseCase, ReconcileWalletUseCase } from '../../src/application/wallet.usecases';
import { loadConfig } from '../../src/config';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
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
  const o = await orm();
  uow = new MikroOrmUnitOfWork(o, DB);
  const processor = new TransactionProcessor(clock, ids, loadConfig());
  submit = new SubmitWagerTransactionUseCase(uow, clock, ids, noopMetrics, processor);
  createWallet = new CreateWalletUseCase(uow, clock, ids);
});

afterAll(async () => {
  await assertGlobalInvariants();
  await closeOrm();
});

async function newWallet(amount = '100.00') {
  return createWallet.execute({ playerId: `p-${Bun.randomUUIDv7()}`, initialBalance: { amount, currency: 'BRL' }, correlationId: 'c' });
}

function bet(w: { id: string; playerId: string }, ext: string, amount: string, extra: Record<string, unknown> = {}) {
  return submit.execute({
    idempotencyKey: `prov:${ext}`, providerId: 'prov', externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
    roundId: 'r', gameId: 'g', kind: 'BET' as never, money: { amount, currency: 'BRL' }, correlationId: 'c', source: 'http', ...extra,
  });
}

/** Runs raw SQL statements in one transaction and returns the SQLSTATE it failed with (or 'ok'). */
async function attemptAll(statements: Array<[string, unknown[]]>): Promise<string> {
  try {
    await (await orm()).em.fork().transactional(async (em) => {
      for (const [query, params] of statements) await em.execute(query, params);
    });
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

const attempt = (query: string, params: unknown[] = []) => attemptAll([[query, params]]);

describe('migrations', () => {
  test('are reversible: down to zero and up again', async () => {
    const migrator = (await orm()).getMigrator();
    await migrator.down({ to: 0 });
    expect((await sql(`select to_regclass('public.wallets') as t`))[0]!.t).toBeNull();
    await migrator.up();
    expect((await sql(`select to_regclass('public.wallets') as t`))[0]!.t).toBe('wallets');
    expect(await migrator.getPendingMigrations()).toHaveLength(0);
  });
});

describe('database constraints (enforced by the schema, not only by code)', () => {
  test('one wallet per player + currency', async () => {
    const w = await newWallet();
    expect(await attempt(`insert into wallets values (gen_random_uuid(), ?, 'BRL', 0, 1, now(), now())`, [w.playerId])).toBe('23505');
  });

  test('balance can never be negative', async () => {
    const w = await newWallet('0');
    expect(await attempt(`update wallets set balance = -0.01, version = version + 1 where id = ?`, [w.id])).toBe('23514');
  });

  test('balance cannot change without a matching ledger entry (deferred check at commit)', async () => {
    const w = await newWallet('10.00');
    expect(await attempt(`update wallets set balance = 999.00, version = version + 1 where id = ?`, [w.id])).toBe('23514');
  });

  test('version must move with the balance', async () => {
    const w = await newWallet('10.00');
    expect(await attempt(`update wallets set version = version + 1 where id = ?`, [w.id])).toBe('23514');
  });

  test('ledger is append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
    const w = await newWallet('10.00');
    expect(await attempt(`update wallet_ledger_entries set amount = 1 where wallet_id = ?`, [w.id])).toBe('23514');
    expect(await attempt(`delete from wallet_ledger_entries where wallet_id = ?`, [w.id])).toBe('23514');
    expect(await attempt(`truncate wallet_ledger_entries cascade`)).toBe('23514');
  });

  test('ledger arithmetic, chain continuity and positive amounts are checked', async () => {
    const w = await newWallet('10.00');
    const tx = (await sql(`select id from wager_transactions where wallet_id = ?`, [w.id]))[0]!.id;
    const ins = `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
                 values (gen_random_uuid(), ?, ?, ?, ?, 'BRL', ?, ?, now())`;
    expect(await attempt(ins, [w.id, tx, 'CREDIT', '5.00', '10.00', '16.00'])).toBe('23514'); // unbalanced
    expect(await attempt(ins, [w.id, tx, 'CREDIT', '5.00', '3.00', '8.00'])).toBe('23514'); // chain gap
    expect(await attempt(ins, [w.id, tx, 'CREDIT', '0.00', '10.00', '10.00'])).toBe('23514'); // zero amount
    expect(await attempt(ins, [w.id, tx, 'CREDIT', '5.00', '10.00', '15.00'])).toBe('23505'); // 2nd entry for same tx
  });

  test('ledger currency must match the wallet currency', async () => {
    const w = await newWallet('10.00');
    // A rejected transaction has no ledger entry yet, so only the currency FK can fail.
    const tx = (await bet(w, 'cur-1', '999.00')).transaction.id;
    expect(
      await attempt(
        `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         values (gen_random_uuid(), ?, ?, 'DEBIT', 1, 'USD', 10, 9, now())`,
        [w.id, tx],
      ),
    ).toBe('23503');
  });

  test('idempotency key and (provider, external id) are unique', async () => {
    const w = await newWallet();
    await bet(w, 'uniq-1', '1.00');
    const row = (await sql(`select * from wager_transactions where external_transaction_id = 'uniq-1'`))[0]!;
    const ins = `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
                 round_id, game_id, kind, amount, currency, status, created_at, updated_at)
                 values (gen_random_uuid(), 'prov', ?, ?, repeat('a', 64), ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', now(), now())`;
    expect(await attempt(ins, ['uniq-2', row.idempotency_key, w.id, w.playerId])).toBe('23505');
    expect(await attempt(ins, ['uniq-1', 'other-key', w.id, w.playerId])).toBe('23505');
  });

  test('terminal transactions are immutable and transactions cannot be deleted', async () => {
    const w = await newWallet();
    const r = await bet(w, 'term-1', '1.00');
    expect(await attempt(`update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ?`, [r.transaction.id])).toBe('23514');
    expect(await attempt(`delete from wager_transactions where id = ?`, [r.transaction.id])).toBe('23514');
  });

  test('REFUND/ROLLBACK require a reference; a reference can be reverted once (partial unique index)', async () => {
    const w = await newWallet();
    const b = await bet(w, 'rev-b', '5.00');
    const ins = `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
                 round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, processed_at, created_at, updated_at)
                 values (gen_random_uuid(), 'prov', ?, ?, repeat('a', 64), ?, ?, 'r', 'g', ?, 5, 'BRL', ?, ?, 'PROCESSED', now(), now(), now())`;
    expect(await attempt(ins, ['rev-x', 'k-x', w.id, w.playerId, 'REFUND', null, null])).toBe('23514');
    expect(
      await attemptAll([
        [ins, ['rev-1', 'k-1', w.id, w.playerId, 'REFUND', 'rev-b', b.transaction.id]],
        [ins, ['rev-2', 'k-2', w.id, w.playerId, 'ROLLBACK', 'rev-b', b.transaction.id]],
      ]),
    ).toBe('23505');
  });
});

describe('atomicity: transaction + wallet + ledger + inbox + outbox commit together or not at all', () => {
  test('a failure while writing the outbox rolls back every other write', async () => {
    const w = await newWallet('50.00');
    const failingUow = {
      run: <T>(work: (ctx: TransactionalContext) => Promise<T>) =>
        uow.run((ctx) =>
          work({
            ...ctx,
            outbox: {
              add: async () => {
                throw new Error('simulated crash before commit');
              },
            },
          }),
        ),
      read: uow.read.bind(uow),
    };
    const processor = new TransactionProcessor(clock, ids, loadConfig());
    const failing = new SubmitWagerTransactionUseCase(failingUow, clock, ids, noopMetrics, processor);
    await expect(
      failing.execute({
        idempotencyKey: 'prov:atomic-1', providerId: 'prov', externalTransactionId: 'atomic-1', playerId: w.playerId, walletId: w.id,
        roundId: 'r', gameId: 'g', kind: 'BET' as never, money: { amount: '20.00', currency: 'BRL' }, correlationId: 'c', source: 'sqs',
        inbox: { messageId: 'atomic-msg-1', consumerName: 'test', payloadHash: 'h'.repeat(64) },
      }),
    ).rejects.toThrow('simulated crash');

    expect((await sql(`select balance::text, version from wallets where id = ?`, [w.id]))[0]).toEqual({ balance: '50.00', version: 1 });
    expect(await sql(`select 1 from wager_transactions where external_transaction_id = 'atomic-1'`)).toHaveLength(0);
    expect(await sql(`select 1 from wallet_ledger_entries where wallet_id = ?`, [w.id])).toHaveLength(1); // opening only
    expect(await sql(`select 1 from inbox_messages where message_id = 'atomic-msg-1'`)).toHaveLength(0);
    expect(await sql(`select 1 from outbox_messages where aggregate_id = ? and event_type <> 'WalletBalanceChanged' and event_type <> 'WagerTransactionProcessed'`, [w.id])).toHaveLength(0);

    // The same message succeeds afterwards: nothing was half-written.
    const ok = await submit.execute({
      idempotencyKey: 'prov:atomic-1', providerId: 'prov', externalTransactionId: 'atomic-1', playerId: w.playerId, walletId: w.id,
      roundId: 'r', gameId: 'g', kind: 'BET' as never, money: { amount: '20.00', currency: 'BRL' }, correlationId: 'c', source: 'sqs',
      inbox: { messageId: 'atomic-msg-1', consumerName: 'test', payloadHash: 'h'.repeat(64) },
    });
    expect(ok.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(ok.idempotentReplay).toBe(false);
    const inbox = await sql(`select processed_at from inbox_messages where message_id = 'atomic-msg-1'`);
    expect(inbox[0]!.processed_at).not.toBeNull();
    const events = await sql(`select event_type from outbox_messages where payload->'data'->>'transactionId' = ?`, [ok.transaction.id]);
    expect(events.map((e) => e.event_type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('outbox rows are written by the same commit as the balance change', async () => {
    const w = await newWallet('10.00');
    const r = await bet(w, 'atomic-2', '3.00');
    const rows = await sql(
      `select o.event_type, (o.payload->'data'->'balanceAfter'->>'amount') as after
         from outbox_messages o where o.payload->'data'->>'transactionId' = ? order by o.sequence`,
      [r.transaction.id],
    );
    expect(rows.map((x) => x.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(rows[1]!.after).toBe('7.00');
  });

  test('reconciliation matches the ledger', async () => {
    const w = await newWallet('10.00');
    await bet(w, 'rec-1', '3.00');
    const report = await new ReconcileWalletUseCase(uow, noopMetrics).execute(w.id);
    expect(report.consistent).toBe(true);
    expect(report.calculatedBalance.amount).toBe('7.00');
    expect(report.checkedEntries).toBe(2);
  });
});
