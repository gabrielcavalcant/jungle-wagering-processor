import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, ValidationError } from '../../src/domain/errors';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('normalizes to fixed scale 2', () => {
    expect(brl('25').amount).toBe('25.00');
    expect(brl('25.5').amount).toBe('25.50');
    expect(brl('0.01').toJSON()).toEqual({ amount: '0.01', currency: 'BRL' });
    expect(brl('25.50').toString()).toBe('25.50 BRL');
  });

  test('exact decimal arithmetic (no floating point drift)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.amount).toBe('10.00');
    expect(brl('100.00').subtract(brl('80.01')).amount).toBe('19.99');
    expect(brl('1.00').subtract(brl('2.50')).amount).toBe('-1.50');
    expect(brl('1.00').negate().amount).toBe('-1.00');
  });

  test('supports very large amounts exactly', () => {
    const big = brl('999999999999999999.99');
    expect(big.amount).toBe('999999999999999999.99');
    expect(big.subtract(brl('0.01')).amount).toBe('999999999999999999.98');
  });

  test.each([
    ['NaN'], ['Infinity'], ['-Infinity'], ['1e5'], ['1E-2'], [''], [' '], ['10.001'], ['10.'], ['.5'],
    ['1,00'], ['+1.00'], ['0x10'], [' 1.00'], ['1.00 '], ['1_000.00'], ['1000000000000000000.00'],
  ])('rejects invalid amount %p', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(ValidationError);
  });

  test('rejects non-string amounts (numbers are never accepted for money)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(ValidationError);
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(ValidationError);
  });

  test('rejects negative values in input contracts but parse() accepts signed persisted values', () => {
    expect(() => brl('-1.00')).toThrow(ValidationError);
    expect(Money.parse({ amount: '-1.00', currency: 'BRL' }).isNegative()).toBe(true);
  });

  test('rounding is never silent: more than 2 decimals is an error, not a rounding', () => {
    expect(() => brl('0.005')).toThrow(ValidationError);
    expect(() => brl('19.999')).toThrow(ValidationError);
  });

  test('rejects invalid currency codes', () => {
    for (const currency of ['brl', 'BR', 'BRLL', '', '12A']) {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(ValidationError);
    }
  });

  test('operations across currencies fail with a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('predicates', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.0').equals(brl('1.00'))).toBe(true);
  });

  test('is immutable', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(b).not.toBe(a);
  });
});
