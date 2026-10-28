import { Inject, Injectable } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SqsGateway, withTimeout } from '../infrastructure/messaging/sqs';

export const ORM = Symbol('ORM');

@Injectable()
export class HealthService {
  private shuttingDown = false;

  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
  ) {}

  markShuttingDown() {
    this.shuttingDown = true;
  }

  async readiness() {
    const check = async (fn: () => Promise<unknown>) => {
      const started = performance.now();
      try {
        await fn();
        return { status: 'ok' as const, latencyMs: Math.round(performance.now() - started) };
      } catch (error) {
        return { status: 'down' as const, error: error instanceof Error ? error.message : String(error) };
      }
    };
    const [postgres, sqs] = await Promise.all([
      check(() => withTimeout(this.orm.em.fork().execute('select 1'), 2_000)),
      check(() => this.sqs.ping(2_000)),
    ]);
    const ok = postgres.status === 'ok' && sqs.status === 'ok' && !this.shuttingDown;
    return { status: ok ? 'ok' : 'unavailable', shuttingDown: this.shuttingDown, checks: { postgres, sqs } };
  }
}
