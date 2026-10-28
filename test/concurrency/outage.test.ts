import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Instance,
  ROOT,
  type TestQueues,
  assertGlobalInvariants,
  closeOrm,
  createQueues,
  createWallet,
  deleteQueues,
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
 * Real outage: the PostgreSQL container is stopped while the service is running and receiving
 * HTTP + SQS traffic, then started again. Nothing is simulated in-process.
 */
async function compose(...args: string[]) {
  const proc = Bun.spawn(['docker', 'compose', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`docker compose ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`);
}

let q: TestQueues;
let app: Instance;

beforeAll(async () => {
  await resetDatabase();
  q = await createQueues('outage', { visibility: 3, maxReceive: 10 });
  app = await spawnInstance('outage-1', 3241, instanceEnv(q, { SQS_MAX_RECEIVE_COUNT: '10', DB_LOCK_TIMEOUT_MS: '2000', DB_STATEMENT_TIMEOUT_MS: '3000', DB_ACQUIRE_TIMEOUT_MS: '3000' }));
}, 60_000);

afterAll(async () => {
  await compose('up', '-d', '--wait', 'postgres').catch(() => undefined);
  await stopInstance(app);
  await assertGlobalInvariants();
  await deleteQueues(q);
  await closeOrm();
}, 90_000);

describe('PostgreSQL temporarily unavailable', () => {
  test('HTTP answers 503 (retryable), SQS messages wait, and after recovery every effect is applied exactly once', async () => {
    const w = await createWallet(app.url, '100.00');
    await closeOrm(); // the test's own pool would also be cut; reopen after the outage

    await compose('stop', 'postgres');
    try {
      // Readiness reports the dependency as down.
      const ready = await http(app.url, 'GET', '/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.checks.postgres.status).toBe('down');
      // Liveness stays up: the process is fine, only a dependency is not.
      expect((await http(app.url, 'GET', '/health/live')).status).toBe(200);

      // HTTP: a clear, retryable infrastructure failure — not a business rejection.
      const started = performance.now();
      const res = await submit(app.url, wager(w, 'outage-http', 'BET', '10.00'));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('TRANSIENT_INFRASTRUCTURE_ERROR');
      expect(res.body.error.retryable).toBe(true);
      expect(performance.now() - started).toBeLessThan(15_000); // fails fast, does not hang

      // SQS: messages arrive during the outage and must not be lost or sent to the DLQ.
      for (let i = 0; i < 5; i++) {
        const ext = `outage-sqs-${i}`;
        await sendWager(q, wagerMessage(`outage-msg-${i}`, { ...wager(w, ext, 'BET', '10.00'), idempotencyKey: `provider-a:${ext}` }));
      }
      await Bun.sleep(4_000); // let the consumer try and fail at least once
    } finally {
      await compose('start', 'postgres');
      await compose('up', '-d', '--wait', 'postgres');
    }

    // Recovery without restarting the service: the pool reconnects on its own.
    await waitFor(async () => (await http(app.url, 'GET', '/health/ready')).status === 200, 60_000, 500);
    await waitFor(async () => {
      const d = await queueDepth(q.inputUrl);
      return d.visible + d.inFlight === 0;
    }, 90_000, 500);
    // The provider retries the HTTP call with the same key (as the 503 told it to).
    const retried = await waitFor(async () => {
      const r = await submit(app.url, wager(w, 'outage-http', 'BET', '10.00'));
      return r.status === 201 || r.status === 200 ? r : undefined;
    }, 30_000, 500);
    expect(retried.body.status).toBe('PROCESSED');

    expect((await http(app.url, 'GET', `/wallets/${w.walletId}`)).body.balance.amount).toBe('40.00');
    expect(await sql(`select 1 from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w.walletId])).toHaveLength(6);
    expect((await queueDepth(q.dlqUrl)).visible).toBe(0);
    expect(await sql(`select 1 from wager_transactions where wallet_id = ? and status = 'FAILED'`, [w.walletId])).toHaveLength(0);
    const recon = await http(app.url, 'POST', `/wallets/${w.walletId}/reconciliation`);
    expect(recon.body.consistent).toBe(true);
    // The retries were visible in the metrics.
    const metrics = await (await fetch(`${app.url}/metrics`)).text();
    expect(metrics).toMatch(/wagering_sqs_messages_total\{outcome="retry"\} [1-9]/);
  }, 180_000);
});
