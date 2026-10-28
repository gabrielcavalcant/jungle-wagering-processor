import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ConcurrencyConflictError,
  ExternalIdConflictError,
  IdempotencyConflictError,
  IdempotencyRaceError,
  ProviderForbiddenError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../application/errors';
import { CurrencyMismatchError, ValidationError } from '../domain/errors';
import { logger } from '../infrastructure/observability/logger';

/**
 * One table, used by every endpoint, so a provider can decide what to do from the status alone:
 *
 * | status | meaning                                    | resend?                         |
 * |--------|--------------------------------------------|---------------------------------|
 * | 400    | invalid payload / missing Idempotency-Key  | no — fix the request            |
 * | 403    | authenticated provider ≠ payload provider  | no                              |
 * | 404    | wallet / transaction not found             | no                              |
 * | 409    | idempotency or uniqueness conflict         | no — same key, different body   |
 * | 422    | business rejection (status REJECTED)       | same key ⇒ same answer          |
 * | 202    | accepted, waiting for reference            | yes, same key, to poll          |
 * | 500    | transaction FAILED (retries exhausted)     | no — same key replays FAILED    |
 * | 503    | transient infrastructure failure           | yes, same key, after Retry-After|
 */
interface ErrorBody {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export function mapError(error: unknown): ErrorBody {
  if (error instanceof ValidationError) {
    return { status: 400, code: error.code, message: error.message, retryable: false, details: error.details };
  }
  if (error instanceof CurrencyMismatchError) {
    return { status: 400, code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof ProviderForbiddenError) {
    return { status: 403, code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return { status: 404, code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof IdempotencyConflictError) {
    return { status: 409, code: error.code, message: error.message, retryable: false, details: { existingTransactionId: error.existingTransactionId } };
  }
  if (error instanceof ExternalIdConflictError || error instanceof WalletAlreadyExistsError) {
    return { status: 409, code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof TransientInfrastructureError || error instanceof ConcurrencyConflictError || error instanceof IdempotencyRaceError) {
    return { status: 503, code: 'TRANSIENT_INFRASTRUCTURE_ERROR', message: 'Temporarily unavailable, retry with the same Idempotency-Key', retryable: true };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return { status, code: status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR', message: error.message, retryable: status >= 500 };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error', retryable: true };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { correlationId?: string }>();
    const body = mapError(exception);
    const log = { correlationId: req.correlationId, path: req.path, status: body.status, code: body.code };
    if (body.status >= 500) logger.error({ ...log, err: exception instanceof Error ? exception.message : String(exception) }, 'request failed');
    else logger.info(log, 'request rejected');
    if (body.status === 503) res.setHeader('Retry-After', '1');
    res.status(body.status).json({ error: { code: body.code, message: body.message, retryable: body.retryable, ...(body.details ? { details: body.details } : {}) } });
  }
}
