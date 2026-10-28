import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.usecase';
import { TransactionProcessor } from '../../src/application/transaction-processor';
import { CreateWalletUseCase } from '../../src/application/wallet.usecases';
import { type AppConfig, loadConfig } from '../../src/config';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';
import { noopMetrics } from '../support/in-memory';
import {
  DB,
  SQS_ENDPOINT,
  type TestQueues,
  assertGlobalInvariants,
  closeOrm,
  createQueues,
  deleteQueues,
  instanceEnv,
  orm,
  queueDepth,
  resetDatabase,
  sendWager,
  spawnInstance,
  sql,
  waitFor,
  wagerMessage,
} from '../support/env';

/**
 * SIGTERM → Nest `beforeApplicationShutdown` → `WagerConsumer.stop()`.
 * Contract: stop receiving, let in-flight messages finish (and be acked), hand back the
 * received-but-not-started ones immediately (visibility 0), never apply anything twice.
 */
let q: TestQueues;
let config: AppConfig;
let gateway: SqsGateway;
let submit: SubmitWagerTransactionUseCase;
let createWallet: CreateWalletUseCase;
const clock = { now: () => new Date() };
const ids = { next: () => Bun.randomUUIDv7() };

beforeAll(async () => {
  await resetDatabase();
  // Long visibility on purpose: a message only comes back quickly if the consumer releases it.
  q = await createQueues('shutdown', { visibility: 30, maxReceive: 5 });
  config = loadConfig();
  config.sqs = {
    ...config.sqs, endpoint: SQS_ENDPOINT, inputQueue: q.input, dlqQueue: q.dlq, eventsQueue: q.events,
    consumerName: 'shutdown-consumer', waitTimeSec: 1, visibilityTimeoutSec: 30, batchSize: 10,
  };
  gateway = new SqsGateway(config.sqs);
  const uow = new MikroOrmUnitOfWork(await orm(), DB);
  submit = new SubmitWagerTransactionUseCase(uow, clock, ids, noopMetrics, new TransactionProcessor(clock, ids, config));
  createWallet = new CreateWalletUseCase(uow, clock, ids);
});

afterAll(async () => {
  await assertGlobalInvariants();
  await deleteQueues(q);
  gateway.destroy();
  await closeOrm();
});

async function balanceOf(walletId: string) {
  return (await sql(`select balance::text as b from wallets where id = ?`, [walletId]))[0]!.b as string;
}

function bets(w: { id: string; playerId: string }, prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) =>
    wagerMessage(`${prefix}-msg-${i}`, {
      providerId: 'provider-a', externalTransactionId: `${prefix}-${i}`, idempotencyKey: `provider-a:${prefix}-${i}`,
      playerId: w.playerId, walletId: w.id, roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '10.00', currency: 'BRL' },
    }),
  );
}

describe('graceful shutdown of the SQS consumer', () => {
  test('in-flight message completes and is acked; not-started ones go back to the queue at once', async () => {
    const w = await createWallet.execute({ playerId: `p-${Bun.randomUUIDv7()}`, initialBalance: { amount: '100.00', currency: 'BRL' }, correlationId: 'c' });
    for (const m of bets(w, 'graceful', 3)) await sendWager(q, m); // same wallet → same group, processed in order

    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((r) => (startedFirst = r));
    let calls = 0;
    const slow = {
      execute: async (cmd: any) => {
        if (++calls === 1) startedFirst();
        await Bun.sleep(1_500); // a slow transaction in progress when SIGTERM arrives
        return submit.execute(cmd);
      },
    } as unknown as SubmitWagerTransactionUseCase;

    const consumer = new WagerConsumer(gateway, slow, config);
    consumer.start();
    await firstStarted;
    const stopStarted = performance.now();
    await consumer.stop(); // what beforeApplicationShutdown does on SIGTERM
    const stopMs = performance.now() - stopStarted;

    // stop() waited for the in-flight message instead of abandoning it mid-transaction…
    expect(stopMs).toBeGreaterThan(1_000);
    expect(calls).toBe(1);
    expect(await balanceOf(w.id)).toBe('90.00');
    // …and the two that never started are visible again right away (visibility timeout is 30 s).
    await waitFor(async () => (await queueDepth(q.inputUrl)).visible === 2, 5_000, 200);

    // A fresh consumer (the next instance) picks them up; nothing is applied twice.
    const next = new WagerConsumer(gateway, submit, config);
    next.start();
    try {
      await waitFor(async () => (await balanceOf(w.id)) === '70.00', 20_000);
      await waitFor(async () => {
        const d = await queueDepth(q.inputUrl);
        return d.visible + d.inFlight === 0;
      }, 20_000);
    } finally {
      await next.stop();
    }
    expect(await sql(`select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.id])).toHaveLength(3);
  }, 60_000);

  // On Windows a child "SIGTERM" is a hard TerminateProcess, so this only runs on POSIX (CI).
  test.skipIf(process.platform === 'win32')('a real process receiving SIGTERM drains and exits cleanly', async () => {
    const w = await createWallet.execute({ playerId: `p-${Bun.randomUUIDv7()}`, initialBalance: { amount: '100.00', currency: 'BRL' }, correlationId: 'c' });
    const app = await spawnInstance('sigterm-1', 3251, instanceEnv(q, { LOG_LEVEL: 'info' }));
    for (const m of bets(w, 'sigterm', 3)) await sendWager(q, m);
    await waitFor(async () => (await balanceOf(w.id)) !== '100.00', 20_000, 50).catch((e) => {
      throw new Error(`${e}\n--- instance logs ---\n${app.logs.join('').slice(-3000)}`);
    });
    app.proc.kill('SIGTERM');
    const code = await Promise.race([app.proc.exited, Bun.sleep(30_000).then(() => 'timeout')]);
    // Nest re-raises the signal after its shutdown hooks finish, so a clean SIGTERM exit is 143 (128 + 15),
    // which is what Docker/Kubernetes expect. 'timeout' would mean it hung instead of draining.
    expect([0, 143]).toContain(code as number);
    const logs = app.logs.join('');
    expect(logs).toContain('shutting down: draining workers');
    expect(logs).toContain('sqs consumer stopped');
    // Whatever was not processed is still in the queue (never lost); a new consumer finishes it.
    const next = new WagerConsumer(gateway, submit, config);
    next.start();
    try {
      await waitFor(async () => (await balanceOf(w.id)) === '70.00', 45_000);
    } finally {
      await next.stop();
    }
  }, 120_000);
});
