import type { LoggerService } from '@nestjs/common';
import pino from 'pino';

/**
 * Structured JSON logs. Only identifiers are logged (correlationId, messageId, transactionId,
 * walletId, providerId) plus status/failureCode — never full payloads, amounts or balances.
 * The redact list is a safety net for accidental object logging.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'wagering-processor', instanceId: process.env.INSTANCE_ID ?? `instance-${process.pid}` },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: [
      'money', '*.money', 'balance', '*.balance', 'amount', '*.amount', 'payload', '*.payload', 'data', '*.data',
      'headers.authorization', 'authorization', 'initialBalance', '*.initialBalance',
    ],
    censor: '[redacted]',
  },
});

export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

/** Adapter so Nest's own messages go through the same JSON pipeline. */
export class NestPinoLogger implements LoggerService {
  log(message: unknown, context?: string) {
    logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    logger.trace({ context }, String(message));
  }
}
