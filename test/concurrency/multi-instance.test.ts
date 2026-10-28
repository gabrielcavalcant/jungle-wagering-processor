import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Instance,
  type TestQueues,
  assertGlobalInvariants,
  closeOrm,
  createQueues,
  createWallet,
  deleteQueues,
  drain,
  http,
  instanceEnv,
  queueDepth,
  resetDatabase,
  sendWager,
  spawnInstance,
  sql,
  stopInstance,
  submit,
  waitFor,
  wager,
  wagerMessage,
} from '../support/env';

/**
 * Real parallelism: three OS processes of the service share PostgreSQL and the SQS queues.
 * Requests are spread round-robin across instances and fired concurrently.
 */
let q: TestQueues;
let instances: Instance[] = [];
const pick = (i: number) => instances[i % instances.length]!.url;

beforeAll(async () => {
  await resetDatabase();
  q = await createQueues('conc', { visibility: 3, maxReceive: 3 });
  const env = instanceEnv(q);
  instances = await Promise.all([3201, 3202, 3203].map((port, i) => spawnInstance(`conc-${i + 1}`, port, env)));
}, 90_000);

afterAll(async () => {
  await Promise.all(instances.map((i) => stopInstance(i)));
  await assertGlobalInvariants();
  await deleteQueues(q);
  await closeOrm();
}, 60_000);

async function balance(walletId: string) {
  return (await http(pick(0), 'GET', `/wallets/${walletId}`)).body.balance.amount as string;
}

async function reconcile(walletId: string) {
  const r = await http(pick(1), 'POST', `/wallets/${walletId}/reconciliation`);
  expect(r.body.consistent).toBe(true);
  return r.body;
}

async function debits(walletId: string) {
  return sql(`select * from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [walletId]);
}

describe('concurrency across 3 instances', () => {
  test('1. the same bet sent 50 times in parallel → exactly one debit', async () => {
    const w = await createWallet(pick(0), '100.00');
    const payload = wager(w, `dup-${Bun.randomUUIDv7()}`, 'BET', '10.00');
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(pick(i), payload)));
    const statuses = new Set(responses.map((r) => r.status));
    expect([...statuses].every((s) => s === 201 || s === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(responses.every((r) => r.body.balance.amount === '90.00')).toBe(true);
    expect(await debits(w.walletId)).toHaveLength(1);
    expect(await balance(w.walletId)).toBe('90.00');
    await reconcile(w.walletId);
  }, 60_000);

  test('2. two 80.00 bets on a 100.00 wallet (repeated 10×): one PROCESSED, one INSUFFICIENT_FUNDS, balance 20.00', async () => {
    for (let round = 0; round < 10; round++) {
      const w = await createWallet(pick(round), '100.00');
      const [a, b] = await Promise.all([
        submit(pick(round), wager(w, `race-a-${round}`, 'BET', '80.00')),
        submit(pick(round + 1), wager(w, `race-b-${round}`, 'BET', '80.00')),
      ]);
      const results = [a, b].map((r) => r.body.status).sort();
      expect(results).toEqual(['PROCESSED', 'REJECTED']);
      const rejected = [a, b].find((r) => r.body.status === 'REJECTED')!;
      expect(rejected.status).toBe(422);
      expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balance(w.walletId)).toBe('20.00');
      expect(await debits(w.walletId)).toHaveLength(1);
      // Retrying both does not duplicate the debit.
      await Promise.all([submit(pick(round + 2), wager(w, `race-a-${round}`, 'BET', '80.00')), submit(pick(round), wager(w, `race-b-${round}`, 'BET', '80.00'))]);
      expect(await debits(w.walletId)).toHaveLength(1);
      await reconcile(w.walletId);
    }
  }, 90_000);

  test('3. different wallets are processed in parallel without interfering', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, (_, i) => createWallet(pick(i), '100.00')));
    const started = performance.now();
    await Promise.all(
      wallets.flatMap((w, wi) => Array.from({ length: 10 }, (_, k) => submit(pick(wi + k), wager(w, `par-${wi}-${k}`, 'BET', '5.00')))),
    );
    const elapsed = performance.now() - started;
    for (const w of wallets) {
      expect(await balance(w.walletId)).toBe('50.00');
      expect(await debits(w.walletId)).toHaveLength(10);
    }
    console.log(`200 bets over 20 wallets on 3 instances: ${elapsed.toFixed(0)}ms`);
  }, 90_000);

  test('4. hot wallets under mixed HTTP + SQS load on 3 instances: no lost update, ledger == balance', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, (_, i) => createWallet(pick(i), '500.00')));
    const ops: Array<Promise<unknown>> = [];
    let n = 0;
    for (let i = 0; i < 240; i++) {
      const w = wallets[i % wallets.length]!;
      const kind = i % 3 === 0 ? 'WIN' : 'BET';
      const amount = `${(i % 7) + 1}.${String(i % 100).padStart(2, '0')}`;
      const ext = `mix-${i}`;
      if (i % 2 === 0) {
        ops.push(submit(pick(n++), wager(w, ext, kind, amount)));
      } else {
        ops.push(sendWager(q, wagerMessage(`mix-msg-${i}`, { ...wager(w, ext, kind, amount), idempotencyKey: `provider-a:${ext}` })));
      }
    }
    await Promise.all(ops);
    await waitFor(async () => (await sql(`select count(*)::int as n from wager_transactions where external_transaction_id like 'mix-%'`))[0]!.n === 240, 60_000);
    for (const w of wallets) {
      const expected = await sql(
        `select (500 + coalesce(sum(case when kind = 'WIN' then amount when kind = 'BET' then -amount end), 0))::numeric(20,2)::text as e
           from wager_transactions where wallet_id = ? and status = 'PROCESSED' and external_transaction_id like 'mix-%'`,
        [w.walletId],
      );
      expect(await balance(w.walletId)).toBe(expected[0]!.e);
      await reconcile(w.walletId);
    }
    const versions = await sql(
      `select w.id, w.version, (select count(*) from wallet_ledger_entries l where l.wallet_id = w.id)::int as entries
         from wallets w where w.id = any(?::uuid[])`,
      [`{${wallets.map((w) => w.walletId).join(',')}}`],
    );
    for (const v of versions) expect(v.version).toBe(v.entries); // version 1 + one bump per movement after opening
  }, 120_000);

  test('7. REFUND / ROLLBACK arriving before their reference are parked and resolved (HTTP and SQS)', async () => {
    const w = await createWallet(pick(0), '100.00');
    const refund = await submit(pick(0), wager(w, 'ooo-refund', 'REFUND', '30.00', { referenceExternalTransactionId: 'ooo-bet' }));
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe('PENDING_REFERENCE');
    // Rollback via SQS, in the same message group, also ahead of the bet it references.
    await sendWager(q, wagerMessage('ooo-msg-rb', { ...wager(w, 'ooo-rb', 'ROLLBACK', '20.00', { referenceExternalTransactionId: 'ooo-bet-2' }), idempotencyKey: 'provider-a:ooo-rb' }));
    await waitFor(async () => (await http(pick(1), 'GET', `/providers/provider-a/wagering/transactions/ooo-rb`)).body?.status === 'PENDING_REFERENCE');

    await submit(pick(1), wager(w, 'ooo-bet', 'BET', '30.00'));
    await sendWager(q, wagerMessage('ooo-msg-bet-2', { ...wager(w, 'ooo-bet-2', 'BET', '20.00'), idempotencyKey: 'provider-a:ooo-bet-2' }));

    await waitFor(async () => {
      const a = (await http(pick(2), 'GET', `/providers/provider-a/wagering/transactions/ooo-refund`)).body;
      const b = (await http(pick(2), 'GET', `/providers/provider-a/wagering/transactions/ooo-rb`)).body;
      return a.status === 'PROCESSED' && b.status === 'PROCESSED';
    }, 30_000);
    expect(await balance(w.walletId)).toBe('100.00');
    // Replay of the originally-pending refund now returns the final result.
    const replay = await submit(pick(2), wager(w, 'ooo-refund', 'REFUND', '30.00', { referenceExternalTransactionId: 'ooo-bet' }));
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    await reconcile(w.walletId);
  }, 60_000);

  test('7b. a reference that never arrives ends REJECTED with REFERENCE_NOT_FOUND', async () => {
    const w = await createWallet(pick(0), '100.00');
    const r = await submit(pick(0), wager(w, 'ghost-refund', 'REFUND', '10.00', { referenceExternalTransactionId: 'ghost-bet' }));
    expect(r.status).toBe(202);
    const final = await waitFor(async () => {
      const t = (await http(pick(1), 'GET', `/wagering/transactions/${r.body.transactionId}`)).body;
      return t.status === 'REJECTED' ? t : undefined;
    }, 30_000);
    expect(final.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(await balance(w.walletId)).toBe('100.00');
  }, 40_000);

  test('6. outbox published by 3 concurrent publishers: every event exactly once in the DB, unique on the wire', async () => {
    await waitFor(async () => (await sql(`select count(*)::int as n from outbox_messages where published_at is null`))[0]!.n === 0, 30_000);
    const publishers = await sql(`select count(*)::int as n from outbox_messages`);
    const events = await drain(q.eventsUrl);
    const ids = new Set(events.map((e) => e.body.eventId));
    expect(ids.size).toBe(events.length);
    expect(events.length).toBe(publishers[0]!.n);
  }, 90_000);
});

describe('crash and restart', () => {
  let cq: TestQueues;
  beforeAll(async () => {
    cq = await createQueues('crash', { visibility: 3, maxReceive: 5 });
  });
  afterAll(async () => {
    await deleteQueues(cq);
  });

  test('5. worker killed after commit and before ack: the redelivery is deduplicated, effect applied once', async () => {
    const w = await createWallet(pick(0), '100.00');
    const crasher = await spawnInstance('crasher', 3211, instanceEnv(cq, { FAULT_INJECTION: 'after-commit-before-ack', OUTBOX_PUBLISHER_ENABLED: 'false' }));
    const msg = wagerMessage('crash-msg-1', { ...wager(w, 'crash-bet', 'BET', '25.00'), idempotencyKey: 'provider-a:crash-bet' });
    await sendWager(cq, msg);
    await waitFor(async () => crasher.proc.exitCode !== null, 20_000);
    expect(crasher.proc.exitCode).toBe(137);
    // Committed …
    expect(await balance(w.walletId)).toBe('75.00');
    // … but never acked: the message is still in the queue.
    const depth = await queueDepth(cq.inputUrl);
    expect(depth.visible + depth.inFlight).toBe(1);

    const healthy = await spawnInstance('healthy', 3212, instanceEnv(cq));
    try {
      await waitFor(async () => {
        const d = await queueDepth(cq.inputUrl);
        return d.visible + d.inFlight === 0;
      }, 30_000);
      expect(await balance(w.walletId)).toBe('75.00');
      expect(await debits(w.walletId)).toHaveLength(1);
      const inbox = await sql(`select processed_at from inbox_messages where message_id = 'crash-msg-1'`);
      expect(inbox).toHaveLength(1);
      await reconcile(w.walletId);
    } finally {
      await stopInstance(healthy);
    }
  }, 90_000);

  test('8. all instances SIGKILLed mid-load and restarted: queue drains, outbox drains, every effect exactly once', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, (_, i) => createWallet(pick(i), '1000.00')));
    const env = instanceEnv(cq);
    let fleet = await Promise.all([3221, 3222, 3223].map((port, i) => spawnInstance(`fleet-${i + 1}`, port, env)));
    const total = 150;
    await Promise.all(
      Array.from({ length: total }, (_, i) => {
        const w = wallets[i % wallets.length]!;
        const ext = `restart-${i}`;
        return sendWager(cq, wagerMessage(`restart-msg-${i}`, { ...wager(w, ext, 'BET', '1.00'), idempotencyKey: `provider-a:${ext}` }));
      }),
    );
    await Bun.sleep(1_500); // let them get partway through
    await Promise.all(fleet.map((i) => stopInstance(i, 'SIGKILL')));
    const midway = (await sql(`select count(*)::int as n from wager_transactions where external_transaction_id like 'restart-%'`))[0]!.n;
    console.log(`processed before the crash: ${midway}/${total}`);

    fleet = await Promise.all([3224, 3225, 3226].map((port, i) => spawnInstance(`fleet-r${i + 1}`, port, env)));
    try {
      await waitFor(async () => (await sql(`select count(*)::int as n from wager_transactions where external_transaction_id like 'restart-%'`))[0]!.n === total, 60_000);
      await waitFor(async () => {
        const d = await queueDepth(cq.inputUrl);
        return d.visible + d.inFlight === 0;
      }, 60_000);
      await waitFor(async () => (await sql(`select count(*)::int as n from outbox_messages where published_at is null`))[0]!.n === 0, 30_000);
      for (const w of wallets) {
        expect(await balance(w.walletId)).toBe('970.00'); // 30 bets of 1.00 each
        expect(await debits(w.walletId)).toHaveLength(30);
        await reconcile(w.walletId);
      }
      expect((await queueDepth(cq.dlqUrl)).visible).toBe(0);
      await assertGlobalInvariants();
    } finally {
      await Promise.all(fleet.map((i) => stopInstance(i)));
    }
  }, 180_000);
});
