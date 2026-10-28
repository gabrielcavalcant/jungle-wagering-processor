import { beforeEach, describe, expect, test } from 'bun:test';
import { ExternalIdConflictError, IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError } from '../../src/application/errors';
import { InvalidTransactionStateError, ValidationError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-codes';
import { LedgerDirection } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { canonicalJson, hashWagerPayload } from '../../src/domain/payload-hash';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { buildInMemory, Kind, Status } from '../support/in-memory';

let env: ReturnType<typeof buildInMemory>;
let walletId: string;

beforeEach(async () => {
  env = buildInMemory();
  const w = await env.createWallet.execute({ playerId: 'p1', initialBalance: { amount: '100.00', currency: 'BRL' }, correlationId: 'c' });
  walletId = w.id;
});

function op(ext: string, kind: Kind, amount: string, extra: Record<string, unknown> = {}) {
  return env.submit.execute({
    idempotencyKey: `prov:${ext}`,
    providerId: 'prov',
    externalTransactionId: ext,
    playerId: 'p1',
    walletId,
    roundId: 'r1',
    gameId: 'g1',
    kind,
    money: { amount, currency: 'BRL' },
    correlationId: 'corr',
    source: 'http',
    ...extra,
  });
}

const balance = () => env.store.wallets.get(walletId)!.balance.amount;
const ledgerOf = () => env.store.ledger.filter((e) => e.walletId === walletId);
async function assertInvariant() {
  const r = await env.reconcile.execute(walletId);
  expect(r.consistent).toBe(true);
}

describe('wallet creation', () => {
  test('initial balance creates an OPENING transaction and a CREDIT entry atomically', () => {
    const opening = [...env.store.txs.values()].find((t) => t.kind === Kind.Opening)!;
    expect(opening.status).toBe(Status.Processed);
    expect(ledgerOf()).toHaveLength(1);
    expect(ledgerOf()[0]!.direction).toBe(LedgerDirection.Credit);
    expect(env.store.wallets.get(walletId)!.version).toBe(1);
  });

  test('duplicate wallet for player + currency is a conflict; another currency is fine', async () => {
    await expect(env.createWallet.execute({ playerId: 'p1', initialBalance: { amount: '1.00', currency: 'BRL' }, correlationId: 'c' })).rejects.toThrow(WalletAlreadyExistsError);
    const usd = await env.createWallet.execute({ playerId: 'p1', initialBalance: { amount: '0', currency: 'USD' }, correlationId: 'c' });
    expect(usd.currency).toBe('USD');
  });

  test('OPENING cannot be submitted externally', async () => {
    await expect(op('o1', Kind.Opening, '10.00')).rejects.toThrow(ValidationError);
  });
});

describe('BET', () => {
  test('debits and writes one DEBIT entry', async () => {
    const r = await op('b1', Kind.Bet, '25.00');
    expect(r.transaction.status).toBe(Status.Processed);
    expect(r.transaction.resultBalance!.amount).toBe('75.00');
    expect(balance()).toBe('75.00');
    expect(ledgerOf().filter((e) => e.direction === LedgerDirection.Debit)).toHaveLength(1);
    await assertInvariant();
  });

  test('insufficient funds is REJECTED, no ledger, balance untouched', async () => {
    const r = await op('b1', Kind.Bet, '100.01');
    expect(r.transaction.status).toBe(Status.Rejected);
    expect(r.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(balance()).toBe('100.00');
    expect(ledgerOf()).toHaveLength(1);
  });

  test('currency mismatch is REJECTED with CURRENCY_MISMATCH', async () => {
    const r = await env.submit.execute({
      idempotencyKey: 'prov:usd', providerId: 'prov', externalTransactionId: 'usd', playerId: 'p1', walletId,
      roundId: 'r1', gameId: 'g1', kind: Kind.Bet, money: { amount: '1.00', currency: 'USD' }, correlationId: 'c', source: 'http',
    });
    expect(r.transaction.status).toBe(Status.Rejected);
    expect(r.transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(balance()).toBe('100.00');
  });

  test('player not owning the wallet is REJECTED', async () => {
    const r = await op('b1', Kind.Bet, '1.00', { playerId: 'someone-else' });
    expect(r.transaction.failureCode).toBe(FailureCode.WalletPlayerMismatch);
  });

  test('unknown wallet is an error, not a persisted rejection', async () => {
    await expect(op('b1', Kind.Bet, '1.00', { walletId: '00000000-0000-7000-8000-999999999999' })).rejects.toThrow(WalletNotFoundError);
  });
});

describe('WIN / LOSS', () => {
  test('WIN credits, optionally referencing the BET of the same round', async () => {
    await op('b1', Kind.Bet, '10.00');
    const r = await op('w1', Kind.Win, '30.00', { referenceExternalTransactionId: 'b1' });
    expect(r.transaction.status).toBe(Status.Processed);
    expect(r.transaction.referenceTransactionId).toBeDefined();
    expect(balance()).toBe('120.00');
    await assertInvariant();
  });

  test('LOSS is PROCESSED with no balance movement and no ledger entry', async () => {
    await op('b1', Kind.Bet, '10.00');
    const before = ledgerOf().length;
    const r = await op('l1', Kind.Loss, '0.00', { referenceExternalTransactionId: 'b1' });
    expect(r.transaction.status).toBe(Status.Processed);
    expect(balance()).toBe('90.00');
    expect(ledgerOf()).toHaveLength(before);
    expect(env.store.outbox.some((m) => m.eventType === 'WagerTransactionProcessed' && (m.payload as any).data.kind === 'LOSS')).toBe(true);
    expect(env.store.outbox.filter((m) => m.eventType === 'WalletBalanceChanged')).toHaveLength(2); // opening + bet
  });
});

describe('REFUND', () => {
  test('reverts a PROCESSED BET exactly once', async () => {
    await op('b1', Kind.Bet, '40.00');
    const r = await op('rf1', Kind.Refund, '40.00', { referenceExternalTransactionId: 'b1' });
    expect(r.transaction.status).toBe(Status.Processed);
    expect(balance()).toBe('100.00');
    const again = await op('rf2', Kind.Refund, '40.00', { referenceExternalTransactionId: 'b1' });
    expect(again.transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(balance()).toBe('100.00');
    await assertInvariant();
  });

  test('requires a reference', async () => {
    await expect(op('rf1', Kind.Refund, '1.00')).rejects.toThrow(ValidationError);
  });

  test('only references BET', async () => {
    await op('w1', Kind.Win, '5.00');
    const r = await op('rf1', Kind.Refund, '5.00', { referenceExternalTransactionId: 'w1' });
    expect(r.transaction.failureCode).toBe(FailureCode.ReferenceInvalidKind);
  });

  test('amount must equal the reference amount', async () => {
    await op('b1', Kind.Bet, '40.00');
    const r = await op('rf1', Kind.Refund, '39.99', { referenceExternalTransactionId: 'b1' });
    expect(r.transaction.failureCode).toBe(FailureCode.AmountMismatch);
  });

  test('reference must be in the same round', async () => {
    await op('b1', Kind.Bet, '40.00');
    const r = await op('rf1', Kind.Refund, '40.00', { referenceExternalTransactionId: 'b1', roundId: 'other' });
    expect(r.transaction.failureCode).toBe(FailureCode.ReferenceMismatch);
  });

  test('a REJECTED bet cannot be refunded', async () => {
    await op('b1', Kind.Bet, '500.00');
    const r = await op('rf1', Kind.Refund, '500.00', { referenceExternalTransactionId: 'b1' });
    expect(r.transaction.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(balance()).toBe('100.00');
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits it back', async () => {
    await op('b1', Kind.Bet, '30.00');
    const r = await op('rb1', Kind.Rollback, '30.00', { referenceExternalTransactionId: 'b1' });
    expect(r.transaction.status).toBe(Status.Processed);
    expect(balance()).toBe('100.00');
    expect(ledgerOf().at(-1)!.direction).toBe(LedgerDirection.Credit);
  });

  test('of a WIN debits it back', async () => {
    await op('w1', Kind.Win, '30.00');
    await op('rb1', Kind.Rollback, '30.00', { referenceExternalTransactionId: 'w1' });
    expect(balance()).toBe('100.00');
    expect(ledgerOf().at(-1)!.direction).toBe(LedgerDirection.Debit);
  });

  test('of a REFUND re-applies the bet debit', async () => {
    await op('b1', Kind.Bet, '30.00');
    await op('rf1', Kind.Refund, '30.00', { referenceExternalTransactionId: 'b1' });
    await op('rb1', Kind.Rollback, '30.00', { referenceExternalTransactionId: 'rf1' });
    expect(balance()).toBe('70.00');
    await assertInvariant();
  });

  test('cannot reference LOSS or another ROLLBACK', async () => {
    await op('b1', Kind.Bet, '1.00');
    await op('l1', Kind.Loss, '0.00');
    expect((await op('rb1', Kind.Rollback, '0.01', { referenceExternalTransactionId: 'l1' })).transaction.failureCode).toBe(FailureCode.ReferenceInvalidKind);
    await op('rb2', Kind.Rollback, '1.00', { referenceExternalTransactionId: 'b1' });
    expect((await op('rb3', Kind.Rollback, '1.00', { referenceExternalTransactionId: 'rb2' })).transaction.failureCode).toBe(FailureCode.ReferenceInvalidKind);
  });

  test('only once per reference (REFUND and ROLLBACK share the single-reversal rule)', async () => {
    await op('b1', Kind.Bet, '10.00');
    await op('rb1', Kind.Rollback, '10.00', { referenceExternalTransactionId: 'b1' });
    expect((await op('rb2', Kind.Rollback, '10.00', { referenceExternalTransactionId: 'b1' })).transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect((await op('rf1', Kind.Refund, '10.00', { referenceExternalTransactionId: 'b1' })).transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(balance()).toBe('100.00');
  });

  test('that would drive the balance negative is REJECTED with a distinct code', async () => {
    await op('w1', Kind.Win, '50.00'); // 150
    await op('b1', Kind.Bet, '140.00'); // 10
    const r = await op('rb1', Kind.Rollback, '50.00', { referenceExternalTransactionId: 'w1' });
    expect(r.transaction.status).toBe(Status.Rejected);
    expect(r.transaction.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(r.transaction.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(balance()).toBe('10.00');
  });
});

describe('out-of-order references', () => {
  test('missing reference parks as PENDING_REFERENCE and resolves when it arrives', async () => {
    const r = await op('rf1', Kind.Refund, '20.00', { referenceExternalTransactionId: 'b1' });
    expect(r.transaction.status).toBe(Status.PendingReference);
    expect(env.store.outbox.some((m) => m.eventType === 'WagerTransactionPendingReference')).toBe(true);
    await op('b1', Kind.Bet, '20.00');
    env.clock.advance(1_000);
    const run = await env.pending.runOnce();
    expect(run.resolved).toBe(1);
    expect(env.store.txs.get(r.transaction.id)!.status).toBe(Status.Processed);
    expect(balance()).toBe('100.00');
    await assertInvariant();
  });

  test('exhausting attempts rejects with REFERENCE_NOT_FOUND and publishes the rejection', async () => {
    const r = await op('rb1', Kind.Rollback, '20.00', { referenceExternalTransactionId: 'never' });
    for (let i = 0; i < 5; i++) {
      env.clock.advance(60_000);
      await env.pending.runOnce();
    }
    const final = env.store.txs.get(r.transaction.id)!;
    expect(final.status).toBe(Status.Rejected);
    expect(final.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(env.store.outbox.some((m) => m.eventType === 'WagerTransactionRejected')).toBe(true);
    expect(env.store.outbox.filter((m) => m.eventType === 'WagerTransactionPendingReference')).toHaveLength(1);
  });

  test('backoff: not re-evaluated before the next check', async () => {
    await op('rf1', Kind.Refund, '20.00', { referenceExternalTransactionId: 'b1' });
    expect((await env.pending.runOnce()).scanned).toBe(0);
    env.clock.advance(1_000);
    expect((await env.pending.runOnce()).rescheduled).toBe(1);
    env.clock.advance(1_000);
    expect((await env.pending.runOnce()).scanned).toBe(0); // second delay is 2s
  });
});

describe('idempotency', () => {
  test('identical request replays the original result, including the balance observed then', async () => {
    const first = await op('b1', Kind.Bet, '10.00');
    await op('b2', Kind.Bet, '10.00');
    const replay = await op('b1', Kind.Bet, '10.00');
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.transaction.resultBalance!.amount).toBe('90.00');
    expect(balance()).toBe('80.00');
  });

  test('rejected transaction replays as rejected', async () => {
    await op('b1', Kind.Bet, '1000.00');
    const replay = await op('b1', Kind.Bet, '1000.00');
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('same key with a divergent payload is a conflict, not a replay', async () => {
    await op('b1', Kind.Bet, '10.00');
    await expect(op('b1', Kind.Bet, '10.01')).rejects.toThrow(IdempotencyConflictError);
    await expect(op('b1', Kind.Bet, '10.00', { roundId: 'r2' })).rejects.toThrow(IdempotencyConflictError);
    expect(balance()).toBe('90.00');
  });

  test('amount normalization: "10" and "10.00" are the same payload', async () => {
    await op('b1', Kind.Bet, '10');
    expect((await op('b1', Kind.Bet, '10.00')).idempotentReplay).toBe(true);
  });

  test('same external id under another key is a conflict', async () => {
    await op('b1', Kind.Bet, '10.00');
    await expect(op('b1', Kind.Bet, '10.00', { idempotencyKey: 'other-key' })).rejects.toThrow(ExternalIdConflictError);
  });

  test('inbox: same messageId is applied once', async () => {
    const inbox = { messageId: 'm1', consumerName: 'c', payloadHash: 'h' };
    const a = await op('b1', Kind.Bet, '10.00', { inbox, source: 'sqs' });
    const b = await op('b1', Kind.Bet, '10.00', { inbox, source: 'sqs' });
    expect(a.duplicateMessage).toBe(false);
    expect(b.duplicateMessage).toBe(true);
    expect(balance()).toBe('90.00');
  });
});

describe('WagerTransaction state machine', () => {
  const props = () => ({
    id: 't', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h', walletId: 'w', playerId: 'pl',
    roundId: 'r', gameId: 'g', kind: Kind.Bet, money: Money.from({ amount: '1.00', currency: 'BRL' }), createdAt: new Date(),
  });

  test('is born PENDING', () => {
    expect(WagerTransaction.create(props()).status).toBe(Status.Pending);
  });

  test('terminal states cannot transition (programming error)', () => {
    const zero = Money.zero('BRL');
    const t = WagerTransaction.create(props());
    t.markProcessed(undefined, new Date(), zero);
    expect(t.isTerminal()).toBe(true);
    expect(() => t.reject(FailureCode.InsufficientFunds, new Date(), zero)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference(new Date(), zero)).toThrow(InvalidTransactionStateError);
    const r = WagerTransaction.create(props());
    r.reject(FailureCode.InsufficientFunds, new Date(), zero);
    expect(() => r.markProcessed(undefined, new Date(), zero)).toThrow(InvalidTransactionStateError);
    const f = WagerTransaction.create(props());
    f.fail(FailureCode.PermanentInfrastructureFailure, new Date());
    expect(() => f.fail(FailureCode.PermanentInfrastructureFailure, new Date())).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE can be re-scheduled and then finalized', () => {
    const zero = Money.zero('BRL');
    const t = WagerTransaction.create({ ...props(), kind: Kind.Refund, referenceExternalTransactionId: 'x' });
    t.markPendingReference(new Date(), zero);
    t.markPendingReference(new Date(), zero);
    expect(t.referenceAttempts).toBe(2);
    t.reject(FailureCode.ReferenceNotFound, new Date(), zero);
    expect(t.status).toBe(Status.Rejected);
  });

  test('domain queries', () => {
    const loss = WagerTransaction.create({ ...props(), kind: Kind.Loss, money: Money.zero('BRL') });
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.requiresReference()).toBe(false);
    expect(WagerTransaction.create({ ...props(), kind: Kind.Rollback, referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
    expect(WagerTransaction.create(props()).matchesPayload('h')).toBe(true);
    expect(() => WagerTransaction.create({ ...props(), money: Money.zero('BRL') })).toThrow(ValidationError);
    expect(() => WagerTransaction.create({ ...props(), referenceExternalTransactionId: 'e' })).toThrow(ValidationError);
  });
});

describe('payload hash', () => {
  test('canonical JSON sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  test('hash ignores key order and changes with any business field', () => {
    const base = { providerId: 'p', externalTransactionId: 'e', playerId: 'pl', walletId: 'w', roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '1.00', currency: 'BRL' } };
    const reordered = { money: { currency: 'BRL', amount: '1.00' }, kind: 'BET', gameId: 'g', roundId: 'r', walletId: 'w', playerId: 'pl', externalTransactionId: 'e', providerId: 'p' };
    expect(hashWagerPayload(base)).toBe(hashWagerPayload(reordered));
    expect(hashWagerPayload(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashWagerPayload({ ...base, gameId: 'g2' })).not.toBe(hashWagerPayload(base));
    expect(hashWagerPayload({ ...base, referenceExternalTransactionId: 'x' })).not.toBe(hashWagerPayload(base));
  });
});
