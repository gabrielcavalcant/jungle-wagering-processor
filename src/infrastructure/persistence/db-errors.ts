import { TransientInfrastructureError } from '../../application/errors';

interface PgLikeError {
  code?: string;
  constraint?: string;
  message?: string;
  cause?: unknown;
}

/** SQLSTATEs that mean "try again": deadlock, serialization, lock/statement timeout, connection loss, shutdown. */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03', '53300', '08000', '08003', '08006', '08001', '08004']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as PgLikeError;
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}

export function constraintOf(error: unknown): string | undefined {
  return (error as PgLikeError)?.constraint;
}

export function isTransientDbError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    const e = current as PgLikeError;
    if (e.code && (TRANSIENT_SQLSTATES.has(e.code) || TRANSIENT_NODE_CODES.has(e.code))) return true;
    if (typeof e.message === 'string' && /connection terminated|timeout acquiring a connection|Connection lost|connect ECONNREFUSED|Knex: Timeout/i.test(e.message)) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/** Normalizes driver errors at the persistence boundary. */
export function translateDbError(error: unknown): unknown {
  if (error instanceof TransientInfrastructureError) return error;
  if (isTransientDbError(error)) {
    const code = (error as PgLikeError).code ?? 'unknown';
    return new TransientInfrastructureError(`Database temporarily unavailable (${code})`, error);
  }
  return error;
}
