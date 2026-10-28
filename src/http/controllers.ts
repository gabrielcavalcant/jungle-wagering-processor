import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ProcessPendingReferencesUseCase } from '../application/process-pending-references.usecase';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.usecase';
import { CreateWalletUseCase, ReconcileWalletUseCase, WalletQueries } from '../application/wallet.usecases';
import { ValidationError } from '../domain/errors';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import { type WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { moneySchema, wagerPayloadSchema } from '../infrastructure/messaging/wager-message.schema';
import { logger } from '../infrastructure/observability/logger';
import { registry } from '../infrastructure/observability/metrics';
import { ProviderAuthGuard } from './auth';
import { HealthService } from './health.service';

type CorrelatedRequest = Request & { correlationId: string };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError('Invalid request payload', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

const walletView = (w: Wallet) => ({
  id: w.id,
  playerId: w.playerId,
  balance: w.balance.toJSON(),
  version: w.version,
  createdAt: w.createdAt.toISOString(),
  updatedAt: w.updatedAt.toISOString(),
});

const entryView = (e: WalletLedgerEntry) => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  createdAt: e.createdAt.toISOString(),
});

export const transactionView = (t: WagerTransaction) => ({
  id: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toJSON(),
  status: t.status,
  failureCode: t.failureCode ?? null,
  referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
  referenceTransactionId: t.referenceTransactionId ?? null,
  balance: t.resultBalance?.toJSON() ?? null,
  createdAt: t.createdAt.toISOString(),
  processedAt: t.processedAt?.toISOString() ?? null,
});

const createWalletSchema = z.object({ playerId: z.string().min(1).max(128), initialBalance: moneySchema }).strict();

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly queries: WalletQueries,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Req() req: CorrelatedRequest) {
    const input = parse(createWalletSchema, body);
    const wallet = await this.createWallet.execute({ ...input, correlationId: req.correlationId });
    logger.info({ correlationId: req.correlationId, walletId: wallet.id }, 'wallet created');
    return walletView(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return walletView(await this.queries.getWallet(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limitRaw?: string) {
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ValidationError('limit must be an integer between 1 and 200');
    const page = await this.queries.getLedger(walletId, cursor || undefined, limit);
    return { items: page.items.map(entryView), nextCursor: page.nextCursor ?? null };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId') walletId: string, @Req() req: CorrelatedRequest) {
    const r = await this.reconcile.execute(walletId);
    logger[r.consistent ? 'info' : 'error']({ correlationId: req.correlationId, walletId, consistent: r.consistent, checkedEntries: r.checkedEntries }, 'wallet reconciled');
    return {
      walletId: r.walletId,
      storedBalance: r.storedBalance.toJSON(),
      calculatedBalance: r.calculatedBalance.toJSON(),
      difference: r.difference.toJSON(),
      consistent: r.consistent,
      checkedEntries: r.checkedEntries,
    };
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: CorrelatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 512) {
      throw new ValidationError('Idempotency-Key header is required (max 512 chars)');
    }
    const input = parse(wagerPayloadSchema, body);
    const result = await this.submit.execute({
      ...input,
      kind: input.kind as WagerTransactionKind,
      idempotencyKey,
      correlationId: req.correlationId,
      source: 'http',
    });
    const tx = result.transaction;
    logger.info(
      { correlationId: req.correlationId, transactionId: tx.id, walletId: tx.walletId, providerId: tx.providerId, status: tx.status, failureCode: tx.failureCode, replay: result.idempotentReplay },
      'wager transaction submitted',
    );
    res.status(statusFor(tx, result.idempotentReplay));
    return {
      transactionId: tx.id,
      status: tx.status,
      ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
      balance: tx.resultBalance?.toJSON() ?? null,
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') id: string) {
    return transactionView(await this.queries.getTransaction(id));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') externalId: string) {
    return transactionView(await this.queries.getTransactionByExternalId(providerId, externalId));
  }
}

/** 201 new & processed · 200 replay · 202 pending reference · 422 business rejection */
function statusFor(tx: WagerTransaction, replay: boolean): number {
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      return replay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

@Controller()
export class OpsController {
  constructor(
    private readonly health: HealthService,
    private readonly pending: ProcessPendingReferencesUseCase,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.health.readiness();
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }

  @Get('metrics')
  async metrics(@Res() res: Response) {
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }
}
