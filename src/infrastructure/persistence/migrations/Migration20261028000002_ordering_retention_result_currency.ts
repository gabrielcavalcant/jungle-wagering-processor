import { Migration } from '@mikro-orm/migrations';

/**
 * - result_currency: the currency of result_balance (the wallet's), stored explicitly so a
 *   transaction row can be read without joining wallets (it differs from `currency` only on
 *   CURRENCY_MISMATCH rejections).
 * - per-aggregate outbox index: the publisher claims the head of each wallet's event stream.
 * - retention indexes for the cleanup job.
 */
export class Migration20261028000002_ordering_retention_result_currency extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table wager_transactions add column result_currency char(3) null;`);
    // Backfill runs while the terminal-state guard is active, so disable it just for this statement.
    this.addSql(`alter table wager_transactions disable trigger wager_tx_guard_update;`);
    this.addSql(`
      update wager_transactions t set result_currency = w.currency
        from wallets w where w.id = t.wallet_id and t.result_balance is not null;`);
    this.addSql(`alter table wager_transactions enable trigger wager_tx_guard_update;`);
    this.addSql(`
      alter table wager_transactions add constraint wager_tx_result_currency_with_balance
        check ((result_balance is null) = (result_currency is null));`);

    this.addSql(`
      create index outbox_pending_by_aggregate_idx on outbox_messages (aggregate_id, sequence)
        where published_at is null;`);
    this.addSql(`create index outbox_published_at_idx on outbox_messages (published_at) where published_at is not null;`);
    this.addSql(`create index inbox_processed_at_idx on inbox_messages (processed_at) where processed_at is not null;`);
  }

  override async down(): Promise<void> {
    this.addSql('drop index if exists inbox_processed_at_idx;');
    this.addSql('drop index if exists outbox_published_at_idx;');
    this.addSql('drop index if exists outbox_pending_by_aggregate_idx;');
    this.addSql('alter table wager_transactions drop constraint if exists wager_tx_result_currency_with_balance;');
    this.addSql('alter table wager_transactions drop column if exists result_currency;');
  }
}
