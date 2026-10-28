import { ApplicationError, TransientInfrastructureError } from '../../application/errors';
import { DomainError } from '../../domain/errors';
import { lockConflicts } from '../observability/metrics';

interface PgLikeError {
  code?: string;
  constraint?: string;
  message?: string;
  cause?: unknown;
  errors?: unknown[];
}

/** SQLSTATEs that mean "try again": deadlock, serialization, lock/statement timeout, connection loss, shutdown. */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03', '53300', '08000', '08003', '08006', '08001', '08004']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED']);
const TRANSIENT_MESSAGES =
  /connection terminated|timeout acquiring a connection|connection lost|connect ECONNREFUSED|Knex: Timeout|query read timeout|timeout exceeded when trying to connect|timeout expired|client was closed|client has encountered a connection error|terminating connection|the database system is|socket hang up|Transaction query already complete/i;
/** A five-character SQLSTATE means the *server* answered: the error is deterministic (constraint, syntax, data…). */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Lock contention that surfaced as an error (counted in wagering_lock_conflicts_total). */
const LOCK_REASONS: Record<string, string> = { '55P03': 'lock_timeout', '40P01': 'deadlock', '40001': 'serialization_failure' };

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as PgLikeError;
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

export function constraintOf(error: unknown): string | undefined {
  return (error as PgLikeError)?.constraint;
}

function matchesKnownTransient(error: unknown): boolean {
  const queue: unknown[] = [error];
  for (let seen = 0; queue.length && seen < 10; seen++) {
    const e = queue.shift() as PgLikeError | undefined;
    if (!e || typeof e !== 'object') continue;
    if (e.code && (TRANSIENT_SQLSTATES.has(e.code) || TRANSIENT_NODE_CODES.has(e.code))) return true;
    if (typeof e.message === 'string' && TRANSIENT_MESSAGES.test(e.message)) return true;
    if (e.cause) queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors); // AggregateError (e.g. IPv4 + IPv6 connect attempts)
  }
  return false;
}

/**
 * Classification at the persistence boundary:
 *  1. known transient codes/messages → transient;
 *  2. our own domain/application errors → unchanged (business outcome);
 *  3. programming errors (TypeError, RangeError, …) → unchanged (a bug must surface as 500, not be retried);
 *  4. the server answered with a SQLSTATE → unchanged (deterministic: constraint, syntax, data);
 *  5. anything else came from the driver/network without a server answer (connection dropped,
 *     client-side timeout, pool) → transient. Retrying is safe: every write is idempotent.
 */
export function isTransientDbError(error: unknown): boolean {
  if (matchesKnownTransient(error)) return true;
  if (error instanceof DomainError || error instanceof ApplicationError) return false;
  if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError) return false;
  const code = (error as PgLikeError)?.code;
  if (typeof code === 'string' && SQLSTATE.test(code)) return false;
  return error instanceof Error;
}

/** Normalizes driver errors at the persistence boundary. */
export function translateDbError(error: unknown): unknown {
  if (error instanceof TransientInfrastructureError) return error;
  if (isTransientDbError(error)) {
    const code = (error as PgLikeError).code ?? 'unknown';
    const reason = LOCK_REASONS[code];
    if (reason) lockConflicts.inc({ reason });
    const detail = (error as Error).message?.slice(0, 120) ?? '';
    return new TransientInfrastructureError(`Database temporarily unavailable (${code}${detail ? `: ${detail}` : ''})`, error);
  }
  return error;
}
