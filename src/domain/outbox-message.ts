import type { IntegrationEvent } from './events';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  lastError?: string;
  /** Insertion order assigned by the database; defines the publish order per aggregate. */
  sequence?: number;
}

export const OUTBOX_BASE_BACKOFF_MS = 500;
export const OUTBOX_MAX_BACKOFF_MS = 60_000;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
    public readonly sequence?: number,
  ) {}

  /** The outbox row id is the event id: a republished event keeps the same id, so consumers can dedup. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
      state.sequence,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and schedules the next try with capped exponential backoff + full jitter. */
  scheduleRetry(now: Date, error?: string, random: () => number = Math.random): void {
    this._attempts += 1;
    this._lastError = error?.slice(0, 500);
    const ceiling = Math.min(OUTBOX_MAX_BACKOFF_MS, OUTBOX_BASE_BACKOFF_MS * 2 ** (this._attempts - 1));
    const delay = Math.max(OUTBOX_BASE_BACKOFF_MS, Math.floor(random() * ceiling));
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
