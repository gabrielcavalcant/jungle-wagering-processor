import { CreateQueueCommand, DeleteMessageBatchCommand, DeleteQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, PurgeQueueCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Subprocess } from 'bun';
import { resolve } from 'node:path';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createOrm } from '../../src/infrastructure/persistence/orm';

/**
 * Real infrastructure for integration/concurrency tests: the docker-compose PostgreSQL
 * (database `wagering_test`) and LocalStack SQS. Each test file gets its own queues.
 * Nothing here is mocked.
 */
export const ROOT = resolve(import.meta.dir, '../..');

export const DB = {
  host: process.env.TEST_DB_HOST ?? 'localhost',
  port: Number(process.env.TEST_DB_PORT ?? 5433),
  user: 'wagering',
  password: 'wagering',
  dbName: process.env.TEST_DB_NAME ?? 'wagering_test',
  poolMax: 10,
  lockTimeoutMs: 5000,
  connectTimeoutMs: 3000,
  acquireTimeoutMs: 10000,
  statementTimeoutMs: 15000,
};
const SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? 'http://localhost:4566';

export const sqs = new SQSClient({ endpoint: SQS_ENDPOINT, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

export interface TestQueues {
  input: string;
  dlq: string;
  events: string;
  inputUrl: string;
  dlqUrl: string;
  eventsUrl: string;
}

export async function createQueues(prefix: string, opts: { visibility?: number; maxReceive?: number } = {}): Promise<TestQueues> {
  const p = `${prefix}-${Date.now().toString(36)}`;
  const names = { input: `${p}-wager.fifo`, dlq: `${p}-dlq.fifo`, events: `${p}-events.fifo` };
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  const dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: names.dlq, Attributes: fifo }))).QueueUrl!;
  const dlqArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn!;
  const inputUrl = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: names.input,
        Attributes: {
          ...fifo,
          VisibilityTimeout: String(opts.visibility ?? 3),
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(opts.maxReceive ?? 3) }),
        },
      }),
    )
  ).QueueUrl!;
  const eventsUrl = (await sqs.send(new CreateQueueCommand({ QueueName: names.events, Attributes: fifo }))).QueueUrl!;
  return { ...names, inputUrl, dlqUrl, eventsUrl };
}

export async function deleteQueues(q: TestQueues) {
  for (const url of [q.inputUrl, q.dlqUrl, q.eventsUrl]) await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
}

export async function purge(url: string) {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
}

export async function queueDepth(url: string): Promise<{ visible: number; inFlight: number }> {
  const a = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }))).Attributes!;
  return { visible: Number(a.ApproximateNumberOfMessages), inFlight: Number(a.ApproximateNumberOfMessagesNotVisible) };
}

export async function drain(url: string, waitSec = 1): Promise<Array<{ body: any; attrs: Record<string, string | undefined> }>> {
  const out: Array<{ body: any; attrs: Record<string, string | undefined> }> = [];
  for (let empty = 0; empty < 2; ) {
    const res = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: waitSec, MessageAttributeNames: ['All'], VisibilityTimeout: 60 }));
    const msgs = res.Messages ?? [];
    if (msgs.length === 0) {
      empty++;
      continue;
    }
    for (const m of msgs) {
      out.push({
        body: JSON.parse(m.Body!),
        attrs: Object.fromEntries(Object.entries(m.MessageAttributes ?? {}).map(([k, v]) => [k, v.StringValue])),
      });
    }
    // FIFO: an undeleted in-flight message blocks the rest of its group, so delete as we read.
    await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: url, Entries: msgs.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })) }));
  }
  return out;
}

export function wagerMessage(messageId: string, data: Record<string, unknown>) {
  return { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data };
}

export async function sendWager(q: TestQueues, msg: ReturnType<typeof wagerMessage>, dedupId = msg.messageId) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: q.inputUrl,
      MessageBody: JSON.stringify(msg),
      MessageGroupId: String((msg.data as { walletId?: string }).walletId ?? 'g'),
      MessageDeduplicationId: dedupId,
    }),
  );
}

// ---------------------------------------------------------------------------- database

let sharedOrm: MikroORM | undefined;
export async function orm(): Promise<MikroORM> {
  sharedOrm ??= await createOrm(DB);
  return sharedOrm;
}

export async function closeOrm() {
  await sharedOrm?.close(true);
  sharedOrm = undefined;
}

/** Full migration down + up: proves reversibility and gives every test file a clean schema. */
export async function resetDatabase(): Promise<void> {
  const o = await orm();
  const migrator = o.getMigrator();
  await migrator.down({ to: 0 });
  await migrator.up();
}

export async function sql<T = Record<string, any>>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await (await orm()).em.fork().execute(query, params, 'all')) as T[];
}

/**
 * The final invariant of every test: for every wallet,
 * balance == Σ ledger, balance == last balance_after, no negative values, chain continuity.
 */
export async function assertGlobalInvariants(): Promise<void> {
  const broken = await sql(`
    with sums as (
      select w.id, w.balance,
             coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0) as ledger_sum
        from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
       group by w.id, w.balance
    )
    select id::text, balance::text, ledger_sum::text from sums where balance <> ledger_sum or balance < 0`);
  if (broken.length) throw new Error(`balance != ledger for ${JSON.stringify(broken)}`);
  const chain = await sql(`
    select wallet_id::text from (
      select wallet_id, balance_before, lag(balance_after) over (partition by wallet_id order by sequence) as prev
        from wallet_ledger_entries) x
     where prev is not null and prev <> balance_before`);
  if (chain.length) throw new Error(`ledger chain broken for ${JSON.stringify(chain)}`);
  const dupEntries = await sql(`select transaction_id from wallet_ledger_entries group by wallet_id, transaction_id having count(*) > 1`);
  if (dupEntries.length) throw new Error('duplicated ledger entries');
}

// ---------------------------------------------------------------------------- app processes

export interface Instance {
  name: string;
  port: number;
  url: string;
  proc: Subprocess;
  logs: string[];
}

export function instanceEnv(q: TestQueues, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    DB_HOST: DB.host,
    DB_PORT: String(DB.port),
    DB_NAME: DB.dbName,
    DB_POOL_MAX: '10',
    SQS_ENDPOINT,
    SQS_INPUT_QUEUE: q.input,
    SQS_DLQ_QUEUE: q.dlq,
    SQS_EVENTS_QUEUE: q.events,
    SQS_WAIT_TIME_SEC: '1',
    SQS_VISIBILITY_TIMEOUT_SEC: '3',
    SQS_MAX_RECEIVE_COUNT: '3',
    SQS_RETRY_BASE_DELAY_SEC: '1',
    OUTBOX_POLL_MS: '200',
    PENDING_REFERENCE_POLL_MS: '200',
    PENDING_REFERENCE_BASE_DELAY_MS: '200',
    PENDING_REFERENCE_MAX_ATTEMPTS: '5',
    LOG_LEVEL: 'warn',
    ...extra,
  };
}

/** Spawns a real OS process running the service and waits for /health/ready. */
export async function spawnInstance(name: string, port: number, env: Record<string, string>): Promise<Instance> {
  const logs: string[] = [];
  const proc = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: ROOT,
    env: { ...env, PORT: String(port), INSTANCE_ID: name },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) logs.push(decoder.decode(chunk));
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>);
  void collect(proc.stderr as ReadableStream<Uint8Array>);
  const instance = { name, port, url: `http://localhost:${port}`, proc, logs };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`${name} exited early (${proc.exitCode}): ${logs.join('').slice(-2000)}`);
    try {
      const res = await fetch(`${instance.url}/health/ready`);
      if (res.ok) return instance;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(250);
  }
  proc.kill('SIGKILL');
  throw new Error(`${name} did not become ready: ${logs.join('').slice(-2000)}`);
}

export async function stopInstance(i: Instance, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
  if (i.proc.exitCode !== null) return;
  i.proc.kill(signal);
  await Promise.race([i.proc.exited, Bun.sleep(15_000)]);
  if (i.proc.exitCode === null) i.proc.kill('SIGKILL');
}

// ---------------------------------------------------------------------------- HTTP helpers

export async function http(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

let playerSeq = 0;
export async function createWallet(base: string, amount = '100.00', currency = 'BRL') {
  const playerId = `player-${Date.now().toString(36)}-${++playerSeq}`;
  const res = await http(base, 'POST', '/wallets', { playerId, initialBalance: { amount, currency } });
  if (res.status !== 201) throw new Error(`create wallet failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { walletId: res.body.id as string, playerId };
}

export function wager(w: { walletId: string; playerId: string }, ext: string, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: ext,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...extra,
  };
}

export function submit(base: string, payload: ReturnType<typeof wager>, key = `${payload.providerId}:${payload.externalTransactionId}`) {
  return http(base, 'POST', '/wagering/transactions', payload, { 'Idempotency-Key': key });
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 20_000, intervalMs = 200): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`waitFor timed out${last ? `: ${String(last)}` : ''}`);
}
