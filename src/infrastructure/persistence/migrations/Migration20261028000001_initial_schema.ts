import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Every guarantee from the challenge's section 6 lives here, not only in code:
 * uniqueness, non-negativity, ledger arithmetic, ledger immutability, terminal-state immutability,
 * single reversal per reference and balance ⇔ ledger consistency (deferred constraint triggers).
 */
export class Migration20261028000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   text not null check (length(player_id) between 1 and 128),
        currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) not null check (balance >= 0),
        version     integer not null check (version >= 1),
        created_at  timestamptz not null,
        updated_at  timestamptz not null,
        constraint wallets_player_currency_uq unique (player_id, currency),
        -- target of the composite FK that pins ledger currency to the wallet currency
        constraint wallets_id_currency_uq unique (id, currency)
      );`);

    // ---------------------------------------------------------------- wager_transactions
    this.addSql(`
      create table wager_transactions (
        id                                uuid primary key,
        provider_id                       text not null check (length(provider_id) between 1 and 128),
        external_transaction_id           text not null check (length(external_transaction_id) between 1 and 256),
        idempotency_key                   text not null check (length(idempotency_key) between 1 and 512),
        payload_hash                      char(64) not null,
        wallet_id                         uuid not null references wallets(id),
        player_id                         text not null,
        round_id                          text not null,
        game_id                           text not null,
        kind                              text not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            numeric(20,2) not null check (amount >= 0),
        currency                          char(3) not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text null,
        reference_transaction_id          uuid null references wager_transactions(id),
        status                            text not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      text null,
        result_balance                    numeric(20,2) null check (result_balance >= 0),
        reference_attempts                integer not null default 0 check (reference_attempts >= 0),
        next_reference_check_at           timestamptz null,
        processed_at                      timestamptz null,
        created_at                        timestamptz not null,
        updated_at                        timestamptz not null,
        constraint wager_tx_idempotency_key_uq unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_tx_reversal_requires_reference
          check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_amount_positive_unless_loss
          check (kind = 'LOSS' or amount > 0),
        constraint wager_tx_failure_code_iff_failed
          check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_tx_pending_reference_has_next_check
          check (status <> 'PENDING_REFERENCE' or next_reference_check_at is not null),
        constraint wager_tx_terminal_has_processed_at
          check (status not in ('PROCESSED','REJECTED','FAILED') or processed_at is not null)
      );`);

    // A reference can be reverted (REFUND or ROLLBACK) at most once.
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');`);
    this.addSql(`
      create index wager_tx_pending_reference_due_idx
        on wager_transactions (next_reference_check_at)
        where status = 'PENDING_REFERENCE';`);
    this.addSql(`
      create index wager_tx_pending_dependents_idx
        on wager_transactions (wallet_id, provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';`);
    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id, created_at);`);

    // Terminal states are final and business fields are immutable once written.
    this.addSql(`
      create function wager_tx_guard_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager_transaction % is terminal (%) and cannot change', old.id, old.status
            using errcode = 'check_violation';
        end if;
        if (new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash, new.wallet_id,
            new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash, old.wallet_id,
            old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'business fields of wager_transaction % are immutable', old.id
            using errcode = 'check_violation';
        end if;
        return new;
      end $$;`);
    this.addSql(`
      create trigger wager_tx_guard_update before update on wager_transactions
        for each row execute function wager_tx_guard_update();`);
    this.addSql(`
      create function forbid_delete() returns trigger language plpgsql as $$
      begin
        raise exception '% rows are append-only (% forbidden)', tg_table_name, tg_op
          using errcode = 'check_violation';
      end $$;`);
    this.addSql(`
      create trigger wager_tx_forbid_delete before delete on wager_transactions
        for each row execute function forbid_delete();`);

    // ---------------------------------------------------------------- wallet_ledger_entries
    this.addSql(`
      create table wallet_ledger_entries (
        sequence        bigserial unique,
        id              uuid primary key,
        wallet_id       uuid not null,
        transaction_id  uuid not null references wager_transactions(id),
        direction       text not null check (direction in ('DEBIT','CREDIT')),
        amount          numeric(20,2) not null check (amount > 0),
        currency        char(3) not null,
        balance_before  numeric(20,2) not null check (balance_before >= 0),
        balance_after   numeric(20,2) not null check (balance_after >= 0),
        created_at      timestamptz not null,
        constraint ledger_wallet_currency_fk foreign key (wallet_id, currency) references wallets (id, currency),
        -- one financial transaction produces at most one entry per wallet
        constraint ledger_wallet_transaction_uq unique (wallet_id, transaction_id),
        constraint ledger_entry_balanced check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );`);
    this.addSql(`create index ledger_wallet_sequence_idx on wallet_ledger_entries (wallet_id, sequence);`);

    // Append-only: no UPDATE, DELETE or TRUNCATE, ever.
    this.addSql(`
      create function ledger_forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only (% forbidden)', tg_op
          using errcode = 'check_violation';
      end $$;`);
    this.addSql(`
      create trigger ledger_forbid_update_delete before update or delete on wallet_ledger_entries
        for each row execute function ledger_forbid_mutation();`);
    this.addSql(`
      create trigger ledger_forbid_truncate before truncate on wallet_ledger_entries
        for each statement execute function ledger_forbid_mutation();`);

    // Chain continuity: a new entry starts where the previous one ended (or at 0 for the first one).
    this.addSql(`
      create function ledger_check_chain() returns trigger language plpgsql as $$
      declare previous numeric(20,2);
      begin
        select balance_after into previous
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by sequence desc
         limit 1;
        if coalesce(previous, 0) <> new.balance_before then
          raise exception 'ledger chain broken for wallet %: previous balance_after %, new balance_before %',
            new.wallet_id, coalesce(previous, 0), new.balance_before
            using errcode = 'check_violation';
        end if;
        return new;
      end $$;`);
    this.addSql(`
      create trigger ledger_check_chain before insert on wallet_ledger_entries
        for each row execute function ledger_check_chain();`);

    // Balance ⇔ ledger: checked at COMMIT (deferred), whichever side was written last.
    this.addSql(`
      create function wallet_balance_matches_ledger() returns trigger language plpgsql as $$
      declare
        target uuid;
        stored numeric(20,2);
        last_after numeric(20,2);
      begin
        if tg_table_name = 'wallet_ledger_entries' then target := new.wallet_id; else target := new.id; end if;
        select balance into stored from wallets where id = target;
        select balance_after into last_after
          from wallet_ledger_entries where wallet_id = target order by sequence desc limit 1;
        if stored <> coalesce(last_after, 0) then
          raise exception 'wallet % balance % does not match ledger %', target, stored, coalesce(last_after, 0)
            using errcode = 'check_violation';
        end if;
        return null;
      end $$;`);
    this.addSql(`
      create constraint trigger wallet_balance_matches_ledger_on_wallet
        after insert or update of balance on wallets
        deferrable initially deferred
        for each row execute function wallet_balance_matches_ledger();`);
    this.addSql(`
      create constraint trigger wallet_balance_matches_ledger_on_entry
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_balance_matches_ledger();`);

    // version moves only with the balance, and only forward by one.
    this.addSql(`
      create function wallet_guard_update() returns trigger language plpgsql as $$
      begin
        if (new.id, new.player_id, new.currency, new.created_at) is distinct from (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'wallet identity fields are immutable' using errcode = 'check_violation';
        end if;
        if new.balance is distinct from old.balance and new.version <> old.version + 1 then
          raise exception 'wallet version must increment by 1 when balance changes' using errcode = 'check_violation';
        end if;
        if new.balance is not distinct from old.balance and new.version <> old.version then
          raise exception 'wallet version must not change without a balance change' using errcode = 'check_violation';
        end if;
        return new;
      end $$;`);
    this.addSql(`
      create trigger wallet_guard_update before update on wallets
        for each row execute function wallet_guard_update();`);
    this.addSql(`
      create trigger wallet_forbid_delete before delete on wallets
        for each row execute function forbid_delete();`);

    // ---------------------------------------------------------------- inbox
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id    text not null,
        payload_hash  char(64) not null,
        received_at   timestamptz not null,
        processed_at  timestamptz null,
        primary key (consumer_name, message_id)
      );`);

    // ---------------------------------------------------------------- outbox
    this.addSql(`
      create table outbox_messages (
        sequence        bigserial unique,
        id              uuid primary key,
        aggregate_id    uuid not null,
        event_type      text not null,
        payload         jsonb not null,
        occurred_at     timestamptz not null,
        attempts        integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz not null,
        locked_by       text null,
        locked_until    timestamptz null,
        published_at    timestamptz null,
        last_error      text null
      );`);
    this.addSql(`
      create index outbox_pending_idx on outbox_messages (next_attempt_at, sequence)
        where published_at is null;`);
    this.addSql(`
      create function outbox_guard_update() returns trigger language plpgsql as $$
      begin
        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
           is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'outbox event content is immutable' using errcode = 'check_violation';
        end if;
        if old.published_at is not null and new.published_at is distinct from old.published_at then
          raise exception 'published_at cannot change once set' using errcode = 'check_violation';
        end if;
        return new;
      end $$;`);
    this.addSql(`
      create trigger outbox_guard_update before update on outbox_messages
        for each row execute function outbox_guard_update();`);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop function if exists outbox_guard_update();');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop function if exists ledger_forbid_mutation();');
    this.addSql('drop function if exists ledger_check_chain();');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop function if exists wager_tx_guard_update();');
    this.addSql('drop table if exists wallets;');
    this.addSql('drop function if exists wallet_balance_matches_ledger();');
    this.addSql('drop function if exists wallet_guard_update();');
    this.addSql('drop function if exists forbid_delete();');
  }
}
