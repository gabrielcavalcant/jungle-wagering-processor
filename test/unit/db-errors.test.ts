import { describe, expect, test } from 'bun:test';
import { IdempotencyRaceError, TransientInfrastructureError, WalletNotFoundError } from '../../src/application/errors';
import { ValidationError } from '../../src/domain/errors';
import { translateDbError } from '../../src/infrastructure/persistence/db-errors';

const pgError = (code: string, message = 'pg error') => Object.assign(new Error(message), { code });

describe('database error classification (decides 503 "retry" vs everything else)', () => {
  test.each([
    ['lock timeout', pgError('55P03')],
    ['deadlock', pgError('40P01')],
    ['server shutting down', pgError('57P01')],
    ['database starting up', pgError('57P03')],
    ['connection refused', pgError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5433')],
    // Seen during a real outage: pg client-side timeout with no SQLSTATE.
    ['pg "timeout expired"', new Error('timeout expired')],
    ['closed client', new Error('Client was closed and is not queryable')],
    ['knex pool timeout', new Error('Knex: Timeout acquiring a connection. The pool is probably full.')],
    ['wrapped in cause', Object.assign(new Error('driver exception'), { cause: pgError('ECONNRESET') })],
    ['AggregateError (IPv4 + IPv6)', new AggregateError([pgError('ECONNREFUSED'), pgError('ECONNREFUSED')], '')],
    ['unknown driver failure without SQLSTATE', new Error('something odd happened on the socket')],
  ])('%s → transient', (_, error) => {
    expect(translateDbError(error)).toBeInstanceOf(TransientInfrastructureError);
  });

  test.each([
    ['check violation (server answered)', pgError('23514')],
    ['unique violation', pgError('23505')],
    ['syntax error in SQL', pgError('42601')],
    ['domain validation', new ValidationError('bad money')],
    ['wallet not found', new WalletNotFoundError('w')],
    ['idempotency race (handled by the use case)', new IdempotencyRaceError('uq')],
    ['programming bug', new TypeError("Cannot read properties of undefined (reading 'x')")],
  ])('%s → kept as is', (_, error) => {
    expect(translateDbError(error)).toBe(error);
  });
});
