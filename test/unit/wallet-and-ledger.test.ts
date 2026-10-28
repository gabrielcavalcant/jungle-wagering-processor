import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, UnbalancedLedgerEntryError, ValidationError } from '../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger-entry';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-01-01T00:00:00Z');
let seq = 0;
const mv = (amount: string) => ({ entryId: `e${++seq}`, transactionId: `t${seq}`, money: brl(amount), at });

function openWith(amount: string): Wallet {
  const w = Wallet.open({ id: 'w1', playerId: 'p1', currency: 'BRL', at });
  if (brl(amount).isPositive()) w.applyOpeningCredit(mv(amount));
  return w;
}

describe('Wallet', () => {
  test('opens at version 1, opening credit keeps version 1 and produces a ledger entry', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', currency: 'BRL', at });
    expect(w.version).toBe(1);
    const entry = w.applyOpeningCredit(mv('100.00'));
    expect(w.version).toBe(1);
    expect(w.balance.amount).toBe('100.00');
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.amount).toBe('0.00');
    expect(entry.balanceAfter.amount).toBe('100.00');
  });

  test('debit and credit move balance, bump version by one and return a balanced entry', () => {
    const w = openWith('100.00');
    const d = w.debit(mv('30.00'));
    expect(w.balance.amount).toBe('70.00');
    expect(w.version).toBe(2);
    expect(d.isBalanced()).toBe(true);
    const c = w.credit(mv('5.50'));
    expect(w.balance.amount).toBe('75.50');
    expect(w.version).toBe(3);
    expect(c.balanceBefore.equals(d.balanceAfter)).toBe(true);
  });

  test('never goes negative: insufficient funds leaves state untouched', () => {
    const w = openWith('10.00');
    expect(w.canDebit(brl('10.01'))).toBe(false);
    expect(() => w.debit(mv('10.01'))).toThrow(InsufficientFundsError);
    expect(w.balance.amount).toBe('10.00');
    expect(w.version).toBe(1);
    w.debit(mv('10.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test('rejects movements in another currency', () => {
    const w = openWith('10.00');
    const usd = { ...mv('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => w.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => w.credit(usd)).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test('rejects zero movements (a balance change must be real)', () => {
    const w = openWith('10.00');
    expect(() => w.credit(mv('0.00'))).toThrow(ValidationError);
  });

  test('ledger replay equals materialized balance', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', currency: 'BRL', at });
    const entries = [w.applyOpeningCredit(mv('50.00')), w.debit(mv('20.00')), w.credit(mv('7.25')), w.debit(mv('37.25'))];
    const rebuilt = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero('BRL'));
    expect(rebuilt.equals(w.balance)).toBe(true);
    expect(w.balance.amount).toBe('0.00');
  });

  test('rehydrate trusts persisted state', () => {
    const w = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: brl('3.00'), version: 42, createdAt: at, updatedAt: at });
    expect(w.version).toBe(42);
    expect(w.balance.amount).toBe('3.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = { id: 'e', walletId: 'w', transactionId: 't', createdAt: at };

  test('validates arithmetic on create', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('1.00'), balanceBefore: brl('1.00'), balanceAfter: brl('3.00') }),
    ).toThrow(UnbalancedLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('2.00'), balanceBefore: brl('1.00'), balanceAfter: Money.parse({ amount: '-1.00', currency: 'BRL' }) }),
    ).toThrow(UnbalancedLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('0.00'), balanceBefore: brl('1.00'), balanceAfter: brl('1.00') }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('is structurally immutable', () => {
    const e = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('1.00'), balanceBefore: brl('3.00'), balanceAfter: brl('2.00') });
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as unknown as { direction: string }).direction = 'CREDIT';
    }).toThrow();
  });
});
