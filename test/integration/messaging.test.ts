import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TransientInfrastructureError } from '../../src/application/errors';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.usecase';
import { TransactionProcessor } from '../../src/application/transaction-processor';
import { CreateWalletUseCase } from '../../src/application/wallet.usecases';
import { type AppConfig, loadConfig } from '../../src/config';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { OutboxPublisher } from '../../src/infrastructure/messaging/workers';
import { OutboxStore } from '../../src/infrastructure/persistence/outbox-store';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';
import { noopMetrics } from '../support/in-memory';
import {
  DB,
  type TestQueues,
  assertGlobalInvariants,
  closeOrm,
  createQueues,
  deleteQueues,
  drain,
  orm,
  queueDepth,
  resetDatabase,
  sendWager,
  sql,
  waitFor,
  wagerMessage,
} from '../support/env';

let q: TestQueues;
let config: AppConfig;
let gateway: SqsGateway;
let submit: SubmitWagerTransactionUseCase;
let createWallet: CreateWalletUseCase;
const clock = { now: () => new Date() };
const ids = { next: () => Bun.randomUUIDv7() };

beforeAll(async () => {
  await resetDatabase();
  q = await createQueues('msg', { visibility: 2, maxReceive: 3 });
  config = loadConfig();
  config.instanceId = 'test-publisher';
  config.sqs = {
    ...config.sqs,
    endpoint: 'http://localhost:4566',
    inputQueue: q.input,
    dlqQueue: q.dlq,
    eventsQueue: q.events,
    consumerName: 'test-consumer',
    waitTimeSec: 1,
    visibilityTimeoutSec: 2,
    maxReceiveCount: 3,
    retryBaseDelaySec: 1,
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

async function newWallet(amount = '100.00') {
  const w = await createWallet.execute({ playerId: `p-${Bun.randomUUIDv7()}`, initialBalance: { amount, currency: 'BRL' }, correlationId: 'c' });
  return { walletId: w.id, playerId: w.playerId };
}

function data(w: { walletId: string; playerId: string }, ext: string, kind = 'BET', amount = '10.00', extra: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a', externalTransactionId: ext, idempotencyKey: `provider-a:${ext}`, playerId: w.playerId, walletId: w.walletId,
    roundId: 'round-1', gameId: 'g', kind, money: { amount, currency: 'BRL' }, ...extra,
  };
}

async function balanceOf(walletId: string) {
  return (await sql(`select balance::text as b from wallets where id = ?`, [walletId]))[0]!.b as string;
}

async function withConsumer<T>(useCase: SubmitWagerTransactionUseCase, fn: () => Promise<T>): Promise<T> {
  const consumer = new WagerConsumer(gateway, useCase, config);
  consumer.start();
  try {
    return await fn();
  } finally {
    await consumer.stop();
  }
}

describe('SQS consumer + inbox', () => {
  test('redelivered message (same messageId) is applied once and acked', async () => {
    const w = await newWallet();
    const msg = wagerMessage(`m-${Bun.randomUUIDv7()}`, data(w, `ext-${Bun.randomUUIDv7()}`));
    // Three physical deliveries of the same logical message (distinct dedup ids defeat FIFO dedup on purpose).
    await sendWager(q, msg, 'd1');
    await sendWager(q, msg, 'd2');
    await sendWager(q, msg, 'd3');
    await withConsumer(submit, () => waitFor(async () => (await queueDepth(q.inputUrl)).visible + (await queueDepth(q.inputUrl)).inFlight === 0));
    expect(await balanceOf(w.walletId)).toBe('90.00');
    const inbox = await sql(`select processed_at from inbox_messages where message_id = ?`, [msg.messageId]);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.processed_at).not.toBeNull();
  });

  test('message whose effect committed but was never acked is deduplicated on redelivery', async () => {
    const w = await newWallet();
    const msg = wagerMessage(`m-${Bun.randomUUIDv7()}`, data(w, `ext-${Bun.randomUUIDv7()}`));
    // Simulate "worker committed, then died before DeleteMessage": run the use case with the inbox record…
    await submit.execute({
      ...(msg.data as any), correlationId: 'c', source: 'sqs',
      inbox: { messageId: msg.messageId, consumerName: config.sqs.consumerName, payloadHash: 'x'.repeat(64) },
    });
    // …then the broker redelivers the message.
    await sendWager(q, msg);
    await withConsumer(submit, () => waitFor(async () => (await queueDepth(q.inputUrl)).visible + (await queueDepth(q.inputUrl)).inFlight === 0));
    expect(await balanceOf(w.walletId)).toBe('90.00');
    expect(await sql(`select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.walletId])).toHaveLength(1);
  });

  test('business rejection is terminal: acked, not retried, not DLQ', async () => {
    const w = await newWallet('5.00');
    const msg = wagerMessage(`m-${Bun.randomUUIDv7()}`, data(w, `ext-${Bun.randomUUIDv7()}`, 'BET', '50.00'));
    await sendWager(q, msg);
    await withConsumer(submit, () => waitFor(async () => (await queueDepth(q.inputUrl)).visible + (await queueDepth(q.inputUrl)).inFlight === 0));
    const tx = await sql(`select status, failure_code from wager_transactions where idempotency_key = ?`, [msg.data.idempotencyKey]);
    expect(tx[0]).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect((await queueDepth(q.dlqUrl)).visible).toBe(0);
  });

  test('permanent errors go straight to the DLQ with a reason', async () => {
    const w = await newWallet();
    await sendWager(q, { messageId: 'bad-1', type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { nope: true } } as any);
    await sendWager(q, wagerMessage('bad-2', data(w, 'bad-money', 'BET', '1e3')));
    await sendWager(q, wagerMessage('bad-3', data(w, 'opening', 'OPENING')));
    await withConsumer(submit, () => waitFor(async () => (await queueDepth(q.inputUrl)).visible + (await queueDepth(q.inputUrl)).inFlight === 0));
    const dlq = await drain(q.dlqUrl);
    expect(dlq.map((m) => m.attrs.dlqReason).sort()).toEqual(['invalid_schema', 'invalid_schema', 'validation_error']);
    expect(await balanceOf(w.walletId)).toBe('100.00');
  });

  test('transient errors are retried with backoff and go to the DLQ after maxReceiveCount', async () => {
    const w = await newWallet();
    let calls = 0;
    const flaky = {
      execute: async () => {
        calls++;
        throw new TransientInfrastructureError('database down (simulated)');
      },
    } as unknown as SubmitWagerTransactionUseCase;
    const msg = wagerMessage(`m-${Bun.randomUUIDv7()}`, data(w, `ext-${Bun.randomUUIDv7()}`));
    await sendWager(q, msg);
    await withConsumer(flaky, () => waitFor(async () => (await queueDepth(q.dlqUrl)).visible > 0, 30_000));
    expect(calls).toBe(3);
    const dlq = await drain(q.dlqUrl);
    expect(dlq[0]!.attrs.dlqReason).toBe('max_receive_count');
    expect(dlq[0]!.body.messageId).toBe(msg.messageId);
    expect(await balanceOf(w.walletId)).toBe('100.00');
  }, 40_000);

  test('transient error followed by recovery: processed exactly once', async () => {
    const w = await newWallet();
    let calls = 0;
    const recovering = {
      execute: async (cmd: any) => {
        if (++calls === 1) throw new TransientInfrastructureError('blip');
        return submit.execute(cmd);
      },
    } as unknown as SubmitWagerTransactionUseCase;
    const msg = wagerMessage(`m-${Bun.randomUUIDv7()}`, data(w, `ext-${Bun.randomUUIDv7()}`));
    await sendWager(q, msg);
    await withConsumer(recovering, () => waitFor(async () => (await balanceOf(w.walletId)) === '90.00', 20_000));
    expect(calls).toBe(2);
  }, 30_000);
});

describe('transactional outbox', () => {
  test('two concurrent publishers drain the outbox without losing events', async () => {
    const w = await newWallet('1000.00');
    for (let i = 0; i < 30; i++) {
      await submit.execute({ ...(data(w, `pub-${i}`, 'BET', '1.00') as any), correlationId: 'c', source: 'http' });
    }
    await drain(q.eventsUrl, 0); // clear anything left from earlier tests
    const store = new OutboxStore(await orm());
    const pubA = new OutboxPublisher(store, gateway, { ...config, instanceId: 'pub-A' });
    const pubB = new OutboxPublisher(store, gateway, { ...config, instanceId: 'pub-B' });
    const loop = async (p: OutboxPublisher) => {
      let total = 0;
      for (let i = 0; i < 20; i++) total += await p.publishOnce();
      return total;
    };
    const [a, b] = await Promise.all([loop(pubA), loop(pubB)]);
    const rows = await sql(`select count(*)::int as n from outbox_messages`);
    expect(a + b).toBe(rows[0]!.n); // every row marked published exactly once
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(await sql(`select 1 from outbox_messages where published_at is null`)).toHaveLength(0);
    const received = await drain(q.eventsUrl);
    const unique = new Set(received.map((m) => m.body.eventId));
    expect(unique.size).toBe(received.length); // FIFO dedup by eventId; consumers would dedup anyway
    expect(received.every((m) => m.attrs.eventId === m.body.eventId && typeof m.body.version === 'number')).toBe(true);
  }, 60_000);

  test('a publisher that dies after claiming loses nothing: the lease expires and another instance publishes', async () => {
    const w = await newWallet('10.00');
    await submit.execute({ ...(data(w, 'lease-1', 'BET', '1.00') as any), correlationId: 'c', source: 'http' });
    const store = new OutboxStore(await orm());
    const claimed = await store.claim('dead-publisher', 100, 1_000); // claims and "crashes"
    expect(claimed.length).toBeGreaterThan(0);
    const survivor = new OutboxPublisher(store, gateway, { ...config, instanceId: 'survivor', workers: { ...config.workers, outboxLeaseMs: 1_000 } });
    expect(await survivor.publishOnce()).toBe(0); // still leased
    await Bun.sleep(1_100);
    expect(await survivor.publishOnce()).toBe(claimed.length);
    // The dead publisher cannot later overwrite the row it no longer owns.
    claimed[0]!.markPublished(new Date());
    expect(await store.markPublished('dead-publisher', claimed[0]!)).toBe(false);
  }, 20_000);

  test('publish failure keeps the event and schedules a retry with backoff', async () => {
    const w = await newWallet('10.00');
    await submit.execute({ ...(data(w, 'retry-pub-1', 'BET', '1.00') as any), correlationId: 'c', source: 'http' });
    const store = new OutboxStore(await orm());
    const broken = new SqsGateway({ ...config.sqs, eventsQueue: 'does-not-exist.fifo' });
    const failing = new OutboxPublisher(store, broken, { ...config, instanceId: 'broken' });
    expect(await failing.publishOnce()).toBe(0);
    const rows = await sql(`select attempts, next_attempt_at > now() as later, last_error is not null as has_error from outbox_messages where published_at is null`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.attempts === 1 && r.later && r.has_error)).toBe(true);
    broken.destroy();
    await Bun.sleep(1_100);
    const ok = new OutboxPublisher(store, gateway, config);
    await waitFor(async () => (await ok.publishOnce()) >= 0 && (await sql(`select 1 from outbox_messages where published_at is null`)).length === 0, 10_000);
  }, 20_000);
});
