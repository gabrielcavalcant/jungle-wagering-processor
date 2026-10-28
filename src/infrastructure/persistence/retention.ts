import type { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '../../config';
import { translateDbError } from './db-errors';

export interface RetentionResult {
  outboxDeleted: number;
  inboxDeleted: number;
}

/**
 * Housekeeping for the two technical tables that would otherwise grow forever.
 * - outbox: only rows already published, older than `outboxHours`;
 * - inbox: only rows already processed, older than `inboxHours`. This must stay above SQS's
 *   maximum retention (14 days) so a message can never be redelivered after its dedup row is gone.
 * Ledger, transactions and wallets are never touched (they are the audit trail).
 * Deletes in small batches with SKIP LOCKED: safe to run on every instance at once.
 */
export class RetentionStore {
  constructor(
    private readonly orm: MikroORM,
    private readonly config: AppConfig['retention'],
  ) {}

  async purgeOnce(now = new Date()): Promise<RetentionResult> {
    try {
      const em = this.orm.em.fork();
      const outboxCutoff = new Date(now.getTime() - this.config.outboxHours * 3_600_000);
      const inboxCutoff = new Date(now.getTime() - this.config.inboxHours * 3_600_000);
      const outbox = (await em.execute(
        `delete from outbox_messages where id in (
           select id from outbox_messages
            where published_at is not null and published_at < ?
            order by published_at limit ? for update skip locked)`,
        [outboxCutoff, this.config.batchSize],
        'run',
      )) as { affectedRows: number };
      const inbox = (await em.execute(
        `delete from inbox_messages where (consumer_name, message_id) in (
           select consumer_name, message_id from inbox_messages
            where processed_at is not null and processed_at < ?
            order by processed_at limit ? for update skip locked)`,
        [inboxCutoff, this.config.batchSize],
        'run',
      )) as { affectedRows: number };
      return { outboxDeleted: outbox.affectedRows, inboxDeleted: inbox.affectedRows };
    } catch (error) {
      throw translateDbError(error);
    }
  }
}
