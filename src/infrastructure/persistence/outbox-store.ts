import type { MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/outbox-message';
import { translateDbError } from './db-errors';

/**
 * Lease-based claiming for concurrent publishers, **ordered per aggregate (wallet)**:
 *   1. one statement: for each wallet, look at the *head* of its unpublished stream (lowest
 *      sequence). A wallet is claimable only if its head is due and not leased, and only if
 *      this statement wins `pg_try_advisory_xact_lock(wallet)` — so two publishers never take
 *      events of the same wallet at the same time. The claimed rows get locked_by/locked_until;
 *   2. publish outside any DB transaction (no row lock held during network I/O), per wallet in
 *      sequence order, stopping that wallet at the first failure;
 *   3. mark published (guarded by locked_by) or schedule a retry of the head, which blocks the
 *      wallet's later events until it goes out — order is preserved.
 * If a publisher dies between 1 and 3, the lease expires and another instance claims the rows.
 * Worst case is a duplicate publish — consumers dedup by eventId.
 */
export class OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claim(publisherId: string, batchSize: number, leaseMs: number): Promise<OutboxMessage[]> {
    try {
      const rows = (await this.orm.em.fork().execute(
        `with heads as (
           select distinct on (aggregate_id) aggregate_id, next_attempt_at, locked_until
             from outbox_messages
            where published_at is null
            order by aggregate_id, sequence
         ),
         ready as (
           select aggregate_id from heads
            where next_attempt_at <= now()
              and (locked_until is null or locked_until < now())
              and pg_try_advisory_xact_lock(hashtextextended(aggregate_id::text, 7))
            limit ?
         ),
         due as (
           select o.id from outbox_messages o
             join ready r on r.aggregate_id = o.aggregate_id
            where o.published_at is null
            order by o.sequence
            limit ?
            for update of o skip locked
         )
         update outbox_messages o
            set locked_by = ?, locked_until = now() + (? || ' milliseconds')::interval
           from due where o.id = due.id
         returning o.*`,
        [batchSize, batchSize, publisherId, String(leaseMs)],
        'all',
      )) as Array<Record<string, any>>;
      return rows
        .sort((a, b) => Number(a.sequence) - Number(b.sequence))
        .map((r) =>
          OutboxMessage.rehydrate({
            id: r.id,
            aggregateId: r.aggregate_id,
            eventType: r.event_type,
            payload: r.payload,
            occurredAt: new Date(r.occurred_at),
            attempts: Number(r.attempts),
            nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at) : undefined,
            publishedAt: r.published_at ? new Date(r.published_at) : undefined,
            lastError: r.last_error ?? undefined,
            sequence: Number(r.sequence),
          }),
        );
    } catch (error) {
      throw translateDbError(error);
    }
  }

  async markPublished(publisherId: string, message: OutboxMessage): Promise<boolean> {
    const res = (await this.orm.em.fork().execute(
      `update outbox_messages set published_at = ?, locked_by = null, locked_until = null
        where id = ? and published_at is null and locked_by = ?`,
      [message.publishedAt ?? new Date(), message.id, publisherId],
      'run',
    )) as { affectedRows: number };
    return res.affectedRows === 1;
  }

  /** Batch version of {@link markPublished}: one round trip per SQS batch. Returns ids actually marked. */
  async markPublishedMany(publisherId: string, ids: string[], at: Date): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = (await this.orm.em.fork().execute(
      `update outbox_messages set published_at = ?, locked_by = null, locked_until = null
        where id = any(?::uuid[]) and published_at is null and locked_by = ?
        returning id`,
      [at, `{${ids.join(',')}}`, publisherId],
      'all',
    )) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  async scheduleRetry(publisherId: string, message: OutboxMessage): Promise<void> {
    await this.orm.em.fork().execute(
      `update outbox_messages set attempts = ?, next_attempt_at = ?, last_error = ?, locked_by = null, locked_until = null
        where id = ? and published_at is null and locked_by = ?`,
      [message.attempts, message.nextAttemptAt ?? new Date(), message.lastError ?? null, message.id, publisherId],
      'run',
    );
  }

  /** Gives back claimed rows that were not attempted (a wallet stopped at an earlier failure). */
  async release(publisherId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.orm.em.fork().execute(
      `update outbox_messages set locked_by = null, locked_until = null
        where id = any(?::uuid[]) and published_at is null and locked_by = ?`,
      [`{${ids.join(',')}}`, publisherId],
      'run',
    );
  }

  /** Seconds since the oldest unpublished event occurred (0 when nothing is pending). */
  async lagSeconds(): Promise<{ lag: number; pending: number }> {
    const rows = (await this.orm.em.fork().execute(
      `select coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as lag, count(*)::int as pending
         from outbox_messages where published_at is null`,
      [],
      'all',
    )) as Array<{ lag: number; pending: number }>;
    return { lag: Number(rows[0]?.lag ?? 0), pending: Number(rows[0]?.pending ?? 0) };
  }
}
