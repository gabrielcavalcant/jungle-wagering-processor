import { CurrencyMismatchError, ValidationError } from './errors';

/** Wire/DTO shape — always a decimal string with exactly 2 fractional digits. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
/** Accepts "0", "10", "10.5", "10.50", optionally signed. No exponent, no spaces, no thousand separators. */
const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/** numeric(20,2) upper bound: 18 integer digits. */
const MAX_MINOR_UNITS = 10n ** 20n - 1n;

/**
 * Immutable monetary value. Internally stored as an integer count of minor units (bigint),
 * so arithmetic is exact — no binary floating point ever touches an amount.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Parses an *input contract* value: non-negative, at most 2 decimals.
   * Use {@link Money.parse} when reading persisted values that may be signed.
   */
  static from(props: MoneyProps): Money {
    const money = Money.parse(props);
    if (money.isNegative()) {
      throw new ValidationError('Money amount must not be negative', { amount: props.amount });
    }
    return money;
  }

  /** Parses a decimal string, allowing a sign. Rejects NaN, Infinity, exponent notation, >2 decimals. */
  static parse(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new ValidationError('Money must be an object { amount, currency }');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string') {
      throw new ValidationError('Money amount must be a decimal string', { amount });
    }
    const match = DECIMAL_PATTERN.exec(amount);
    if (!match) {
      throw new ValidationError('Invalid money amount: expected a decimal string with at most 2 decimals', {
        amount,
      });
    }
    const [, sign, integerPart, fraction = ''] = match;
    const minorAbs = BigInt(integerPart!) * FACTOR + BigInt(fraction.padEnd(SCALE, '0') || '0');
    if (minorAbs > MAX_MINOR_UNITS) {
      throw new ValidationError('Money amount exceeds the supported precision', { amount });
    }
    return new Money(sign ? -minorAbs : minorAbs, Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.assertCurrency(currency));
  }

  /** Builds from integer minor units (cents). Used by aggregation code, never by input contracts. */
  static ofMinor(minor: bigint, currency: string): Money {
    return new Money(minor, Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  get minorUnits(): bigint {
    return this.minor;
  }

  /** Decimal string with fixed scale 2, e.g. "25.00", "-0.50". */
  get amount(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const integer = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${integer.toString()}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new ValidationError('Currency must be an ISO-4217 alpha-3 code', { currency });
    }
    return currency;
  }
}
