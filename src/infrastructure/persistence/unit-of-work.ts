import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { TransactionalContext, UnitOfWork } from '../../application/ports';
import type { AppConfig } from '../../config';
import { translateDbError } from './db-errors';
import {
  SqlInboxRepository,
  SqlLedgerRepository,
  SqlOutboxRepository,
  SqlWagerTransactionRepository,
  SqlWalletRepository,
} from './repositories';

function contextFor(em: EntityManager): TransactionalContext {
  return {
    wallets: new SqlWalletRepository(em),
    transactions: new SqlWagerTransactionRepository(em),
    ledger: new SqlLedgerRepository(em),
    inbox: new SqlInboxRepository(em),
    outbox: new SqlOutboxRepository(em),
  };
}

/**
 * MikroORM-backed unit of work. Each `run` gets a fresh forked EntityManager (no shared identity
 * map between requests) and one `em.transactional()` — a single PostgreSQL transaction at
 * READ COMMITTED. Correctness comes from the wallet row lock + constraints, not from isolation level.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly db: AppConfig['db'],
  ) {}

  async run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          // Bounded waits: a stuck lock or query becomes a retryable error instead of a hung worker.
          await em.execute(`set local lock_timeout = '${Number(this.db.lockTimeoutMs)}ms'`);
          await em.execute(`set local statement_timeout = '${Number(this.db.statementTimeoutMs)}ms'`);
          return work(contextFor(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw translateDbError(error);
    }
  }

  async read<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    try {
      return await work(contextFor(this.orm.em.fork()));
    } catch (error) {
      throw translateDbError(error);
    }
  }
}
