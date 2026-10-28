import { randomUUID } from 'node:crypto';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { NextFunction, Request, Response } from 'express';
import { METRICS } from './application/metrics.port';
import { CLOCK, ID_GENERATOR, PROVIDER_IDENTITY, UNIT_OF_WORK } from './application/ports';
import { ProcessPendingReferencesUseCase } from './application/process-pending-references.usecase';
import { RecordPermanentFailureUseCase } from './application/record-permanent-failure.usecase';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.usecase';
import { TransactionProcessor } from './application/transaction-processor';
import { CreateWalletUseCase, ReconcileWalletUseCase, WalletQueries } from './application/wallet.usecases';
import { type AppConfig, CONFIG, loadConfig } from './config';
import { NoopProviderIdentity, ProviderAuthGuard } from './http/auth';
import { OpsController, WageringController, WalletsController } from './http/controllers';
import { HealthService, ORM } from './http/health.service';
import { SqsGateway } from './infrastructure/messaging/sqs';
import { WagerConsumer } from './infrastructure/messaging/wager-consumer';
import { OutboxPublisher, PeriodicWorker, pendingReferenceTick } from './infrastructure/messaging/workers';
import { logger } from './infrastructure/observability/logger';
import { PromMetrics } from './infrastructure/observability/metrics';
import { createOrm } from './infrastructure/persistence/orm';
import { OutboxStore } from './infrastructure/persistence/outbox-store';
import { RetentionStore } from './infrastructure/persistence/retention';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/unit-of-work';

/** Starts/stops the background loops with the Nest lifecycle (SIGTERM → beforeApplicationShutdown). */
@Injectable()
class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly consumer: WagerConsumer;
  private readonly outbox: PeriodicWorker;
  private readonly pending: PeriodicWorker;
  private readonly retention: PeriodicWorker;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(ORM) private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
    private readonly health: HealthService,
    submit: SubmitWagerTransactionUseCase,
    pendingUseCase: ProcessPendingReferencesUseCase,
    failures: RecordPermanentFailureUseCase,
  ) {
    this.consumer = new WagerConsumer(sqs, submit, config, failures);
    const publisher = new OutboxPublisher(new OutboxStore(orm), sqs, config);
    this.outbox = new PeriodicWorker('outbox-publisher', config.workers.outboxPollMs, () => publisher.publishOnce());
    this.pending = new PeriodicWorker('pending-references', config.workers.pendingReferencePollMs, pendingReferenceTick(pendingUseCase));
    const retention = new RetentionStore(orm, config.retention);
    this.retention = new PeriodicWorker('retention', config.retention.pollMs, async () => {
      const r = await retention.purgeOnce();
      if (r.outboxDeleted || r.inboxDeleted) logger.info({ ...r }, 'retention purge');
    });
  }

  onApplicationBootstrap() {
    if (this.config.workers.consumerEnabled) this.consumer.start();
    if (this.config.workers.outboxEnabled) this.outbox.start();
    if (this.config.workers.pendingReferenceEnabled) this.pending.start();
    if (this.config.retention.enabled) this.retention.start();
  }

  async beforeApplicationShutdown(signal?: string) {
    logger.info({ signal }, 'shutting down: draining workers');
    this.health.markShuttingDown();
    await Promise.all([this.consumer.stop(), this.outbox.stop(), this.pending.stop(), this.retention.stop()]);
  }

  async onApplicationShutdown() {
    this.sqs.destroy();
    await this.orm.close(true);
  }
}

@Module({
  controllers: [WalletsController, WageringController, OpsController],
  providers: [
    { provide: CONFIG, useFactory: loadConfig },
    { provide: ORM, inject: [CONFIG], useFactory: (c: AppConfig) => createOrm(c.db) },
    { provide: UNIT_OF_WORK, inject: [ORM, CONFIG], useFactory: (orm: MikroORM, c: AppConfig) => new MikroOrmUnitOfWork(orm, c.db) },
    { provide: SqsGateway, inject: [CONFIG], useFactory: (c: AppConfig) => new SqsGateway(c.sqs) },
    { provide: CLOCK, useValue: { now: () => new Date() } },
    { provide: ID_GENERATOR, useValue: { next: () => Bun.randomUUIDv7() } },
    { provide: METRICS, useClass: PromMetrics },
    { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
    ProviderAuthGuard,
    HealthService,
    TransactionProcessor,
    SubmitWagerTransactionUseCase,
    CreateWalletUseCase,
    WalletQueries,
    ReconcileWalletUseCase,
    ProcessPendingReferencesUseCase,
    RecordPermanentFailureUseCase,
    BackgroundWorkers,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((req: Request & { correlationId?: string }, res: Response, next: NextFunction) => {
        const header = req.header('x-correlation-id');
        req.correlationId = header && header.length <= 128 ? header : randomUUID();
        res.setHeader('x-correlation-id', req.correlationId);
        next();
      })
      .forRoutes('*');
  }
}
