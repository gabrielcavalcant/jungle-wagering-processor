import { CurrencyMismatchError, InsufficientFundsError, ValidationError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root. The only way to change the balance is through {@link debit}/{@link credit},
 * and both return the ledger entry describing exactly that change — balance and ledger can't
 * drift apart in memory. `version` starts at 1 and increments only when the balance changes.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet with a zero balance. The initial balance, when positive, is applied through
   * {@link credit} by the caller (as an OPENING transaction) so it gets a ledger entry like any
   * other movement. Opening does not bump the version: version 1 = "as created", regardless of
   * whether the opening credit exists.
   */
  static open(props: { id: string; playerId: string; currency: string; at: Date }): Wallet {
    if (!props.playerId) throw new ValidationError('playerId is required');
    const zero = Money.zero(props.currency);
    return new Wallet(props.id, props.playerId, zero.currency, zero, 1, props.at, props.at);
  }

  /** Reconstruction from persistence — trusts the stored state, does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    this.assertPositive(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertSameCurrency(movement.money);
    this.assertPositive(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  /** Opening credit: same ledger semantics as credit, but keeps version at 1 (wallet "as created"). */
  applyOpeningCredit(movement: BalanceMovement): WalletLedgerEntry {
    const entry = this.credit(movement);
    this._version = 1;
    return entry;
  }

  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(movement.money) : before.subtract(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: movement.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;
    return entry;
  }

  private assertPositive(money: Money): void {
    if (!money.isPositive()) {
      throw new ValidationError('Movement amount must be strictly positive', { amount: money.amount });
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
