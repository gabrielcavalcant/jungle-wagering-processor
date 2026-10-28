import type { OpenAPIObject } from '@nestjs/swagger';
import { FailureCode } from '../domain/failure-codes';
import { EXTERNAL_KINDS, WagerTransactionStatus } from '../domain/wager-transaction';

/**
 * OpenAPI 3 contract, served at /docs (Swagger UI) and /docs/openapi.json.
 * Written explicitly (validation lives in zod schemas, not decorated DTO classes) so every
 * status code and its meaning for the provider is documented exactly as implemented.
 */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object, example?: unknown) => ({ 'application/json': { schema, ...(example ? { example } : {}) } });
const error = (description: string, code: string, retryable = false) => ({
  description,
  content: json(ref('Error'), { error: { code, message: description, retryable } }),
});

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const TX_ID = '0192f298-345e-7e38-af88-e43f851a819d';

export const openApiDocument: OpenAPIObject = {
  openapi: '3.0.3',
  info: {
    title: 'Distributed Wagering Processor',
    version: '1.0.0',
    description: [
      'Processes wagering transactions (BET → WIN | LOSS | REFUND | ROLLBACK) from multiple game providers.',
      '',
      '**Idempotency:** `POST /wagering/transactions` requires the `Idempotency-Key` header (recommended `{providerId}:{externalTransactionId}`).',
      'Same key + same payload → original result with `idempotentReplay: true`. Same key + different payload → `409`.',
      '',
      '**Status codes** are consistent across endpoints: `400` invalid payload · `404` not found · `409` idempotency/uniqueness conflict ·',
      '`422` business rejection (`failureCode`) · `202` accepted, waiting for reference · `500` FAILED (retries exhausted) · `503` transient, retry with the same key.',
      '',
      'Money is always a decimal **string** with 2 decimals: `{ "amount": "25.00", "currency": "BRL" }`.',
    ].join('\n'),
  },
  tags: [
    { name: 'Wallets', description: 'Wallets, ledger and reconciliation' },
    { name: 'Wagering', description: 'Submit and query wager transactions' },
    { name: 'Operations', description: 'Health checks and metrics (no authentication)' },
  ],
  paths: {
    '/wallets': {
      post: {
        tags: ['Wallets'],
        summary: 'Create a wallet',
        description: 'A positive initial balance creates an internal OPENING transaction and a CREDIT ledger entry in the same SQL transaction.',
        requestBody: {
          required: true,
          content: json(ref('CreateWalletRequest'), { playerId: PLAYER_ID, initialBalance: { amount: '1000.00', currency: 'BRL' } }),
        },
        responses: {
          '201': { description: 'Created', content: json(ref('Wallet')) },
          '400': error('Invalid payload', 'VALIDATION_ERROR'),
          '409': error('A wallet already exists for this player and currency', 'WALLET_ALREADY_EXISTS'),
          '503': error('Temporarily unavailable', 'TRANSIENT_INFRASTRUCTURE_ERROR', true),
        },
      },
    },
    '/wallets/{walletId}': {
      get: {
        tags: ['Wallets'],
        summary: 'Get a wallet (balance and version)',
        parameters: [{ $ref: '#/components/parameters/walletId' }],
        responses: { '200': { description: 'OK', content: json(ref('Wallet')) }, '404': error('Wallet not found', 'WALLET_NOT_FOUND') },
      },
    },
    '/wallets/{walletId}/ledger': {
      get: {
        tags: ['Wallets'],
        summary: 'Ledger entries (append-only), keyset-paginated',
        parameters: [
          { $ref: '#/components/parameters/walletId' },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque cursor from `nextCursor`' },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: {
          '200': { description: 'OK', content: json(ref('LedgerPage')) },
          '400': error('Invalid cursor or limit', 'VALIDATION_ERROR'),
          '404': error('Wallet not found', 'WALLET_NOT_FOUND'),
        },
      },
    },
    '/wallets/{walletId}/reconciliation': {
      post: {
        tags: ['Wallets'],
        summary: 'Compare stored balance with the balance rebuilt from the ledger',
        description: 'Never corrects anything. A divergence is logged, counted in a metric and reported with `consistent: false`.',
        parameters: [{ $ref: '#/components/parameters/walletId' }],
        responses: { '200': { description: 'Report', content: json(ref('Reconciliation')) }, '404': error('Wallet not found', 'WALLET_NOT_FOUND') },
      },
    },
    '/wagering/transactions': {
      post: {
        tags: ['Wagering'],
        summary: 'Submit a wager transaction',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', maxLength: 512 },
            example: 'provider-a:transaction-123',
            description: 'Source of truth for idempotency. Recommended: `{providerId}:{externalTransactionId}`.',
          },
          { name: 'x-correlation-id', in: 'header', required: false, schema: { type: 'string' }, description: 'Propagated to logs and events' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: ref('WagerRequest'),
              examples: {
                bet: {
                  summary: 'BET',
                  value: {
                    providerId: 'provider-a', externalTransactionId: 'transaction-123', playerId: PLAYER_ID, walletId: WALLET_ID,
                    roundId: 'round-987', gameId: 'fortune-chimp', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
                  },
                },
                refund: {
                  summary: 'REFUND of a BET',
                  value: {
                    providerId: 'provider-a', externalTransactionId: 'transaction-124', playerId: PLAYER_ID, walletId: WALLET_ID,
                    roundId: 'round-987', gameId: 'fortune-chimp', kind: 'REFUND', money: { amount: '25.00', currency: 'BRL' },
                    referenceExternalTransactionId: 'transaction-123',
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'New transaction, PROCESSED', content: json(ref('WagerResponse'), { transactionId: TX_ID, status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false }) },
          '200': { description: 'Idempotent replay: the original result, including the balance observed at the time', content: json(ref('WagerResponse'), { transactionId: TX_ID, status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: true }) },
          '202': { description: 'Accepted, waiting for the referenced transaction (PENDING_REFERENCE). Resolved by a worker with backoff.', content: json(ref('WagerResponse'), { transactionId: TX_ID, status: 'PENDING_REFERENCE', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false }) },
          '400': error('Invalid payload or missing Idempotency-Key', 'VALIDATION_ERROR'),
          '404': error('Wallet not found', 'WALLET_NOT_FOUND'),
          '409': error('Same Idempotency-Key with a different payload (never a replay)', 'IDEMPOTENCY_KEY_CONFLICT'),
          '422': { description: 'Business rejection (status REJECTED). See `failureCode`.', content: json(ref('WagerResponse'), { transactionId: TX_ID, status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '20.00', currency: 'BRL' }, idempotentReplay: false }) },
          '500': { description: 'Transaction FAILED (PERMANENT_INFRASTRUCTURE_FAILURE): retries were exhausted. Do not resend with the same key.', content: json(ref('WagerResponse')) },
          '503': error('Transient infrastructure failure — retry with the same Idempotency-Key after Retry-After', 'TRANSIENT_INFRASTRUCTURE_ERROR', true),
        },
      },
    },
    '/wagering/transactions/{transactionId}': {
      get: {
        tags: ['Wagering'],
        summary: 'Get a transaction by internal id',
        parameters: [{ name: 'transactionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'OK', content: json(ref('Transaction')) }, '404': error('Transaction not found', 'TRANSACTION_NOT_FOUND') },
      },
    },
    '/providers/{providerId}/wagering/transactions/{externalTransactionId}': {
      get: {
        tags: ['Wagering'],
        summary: "Get a transaction by the provider's id",
        parameters: [
          { name: 'providerId', in: 'path', required: true, schema: { type: 'string' }, example: 'provider-a' },
          { name: 'externalTransactionId', in: 'path', required: true, schema: { type: 'string' }, example: 'transaction-123' },
        ],
        responses: { '200': { description: 'OK', content: json(ref('Transaction')) }, '404': error('Transaction not found', 'TRANSACTION_NOT_FOUND') },
      },
    },
    '/health/live': {
      get: { tags: ['Operations'], summary: 'Liveness (process is up)', responses: { '200': { description: 'OK', content: json({ type: 'object' }, { status: 'ok' }) } } },
    },
    '/health/ready': {
      get: {
        tags: ['Operations'],
        summary: 'Readiness (PostgreSQL and SQS reachable)',
        responses: {
          '200': { description: 'Ready', content: json({ type: 'object' }, { status: 'ok', shuttingDown: false, checks: { postgres: { status: 'ok', latencyMs: 4 }, sqs: { status: 'ok', latencyMs: 12 } } }) },
          '503': { description: 'A dependency is down or the instance is shutting down' },
        },
      },
    },
    '/metrics': {
      get: { tags: ['Operations'], summary: 'Prometheus metrics', responses: { '200': { description: 'text/plain exposition format' } } },
    },
  },
  components: {
    parameters: {
      walletId: { name: 'walletId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, example: WALLET_ID },
    },
    schemas: {
      Money: {
        type: 'object',
        required: ['amount', 'currency'],
        properties: {
          amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$', example: '25.00', description: 'Decimal string, max 2 decimals. Never a JSON number.' },
          currency: { type: 'string', pattern: '^[A-Z]{3}$', example: 'BRL' },
        },
      },
      CreateWalletRequest: {
        type: 'object',
        required: ['playerId', 'initialBalance'],
        properties: { playerId: { type: 'string', example: PLAYER_ID }, initialBalance: ref('Money') },
      },
      Wallet: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', example: WALLET_ID },
          playerId: { type: 'string', example: PLAYER_ID },
          balance: ref('Money'),
          version: { type: 'integer', example: 1, description: 'Starts at 1, +1 on every balance change' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      WagerRequest: {
        type: 'object',
        required: ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'],
        properties: {
          providerId: { type: 'string', example: 'provider-a' },
          externalTransactionId: { type: 'string', example: 'transaction-123' },
          playerId: { type: 'string', example: PLAYER_ID },
          walletId: { type: 'string', format: 'uuid', example: WALLET_ID },
          roundId: { type: 'string', example: 'round-987' },
          gameId: { type: 'string', example: 'fortune-chimp' },
          kind: { type: 'string', enum: [...EXTERNAL_KINDS], description: 'OPENING is internal and cannot be submitted' },
          money: ref('Money'),
          referenceExternalTransactionId: { type: 'string', description: 'Required for REFUND and ROLLBACK; optional for WIN/LOSS (must be the BET)' },
        },
      },
      WagerResponse: {
        type: 'object',
        properties: {
          transactionId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: Object.values(WagerTransactionStatus) },
          failureCode: { type: 'string', enum: Object.values(FailureCode) },
          balance: { ...ref('Money'), description: 'Balance observed when the transaction reached this state' },
          idempotentReplay: { type: 'boolean' },
        },
      },
      Transaction: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          providerId: { type: 'string' },
          externalTransactionId: { type: 'string' },
          walletId: { type: 'string', format: 'uuid' },
          playerId: { type: 'string' },
          roundId: { type: 'string' },
          gameId: { type: 'string' },
          kind: { type: 'string', enum: ['OPENING', ...EXTERNAL_KINDS] },
          money: ref('Money'),
          status: { type: 'string', enum: Object.values(WagerTransactionStatus) },
          failureCode: { type: 'string', nullable: true, enum: [...Object.values(FailureCode), null] },
          referenceExternalTransactionId: { type: 'string', nullable: true },
          referenceTransactionId: { type: 'string', format: 'uuid', nullable: true },
          balance: { ...ref('Money'), nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          processedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      LedgerEntry: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          transactionId: { type: 'string', format: 'uuid' },
          direction: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
          money: ref('Money'),
          balanceBefore: ref('Money'),
          balanceAfter: ref('Money'),
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      LedgerPage: {
        type: 'object',
        properties: { items: { type: 'array', items: ref('LedgerEntry') }, nextCursor: { type: 'string', nullable: true } },
      },
      Reconciliation: {
        type: 'object',
        properties: {
          walletId: { type: 'string', format: 'uuid' },
          storedBalance: ref('Money'),
          calculatedBalance: ref('Money'),
          difference: ref('Money'),
          consistent: { type: 'boolean' },
          checkedEntries: { type: 'integer' },
        },
        example: {
          walletId: WALLET_ID,
          storedBalance: { amount: '975.00', currency: 'BRL' },
          calculatedBalance: { amount: '975.00', currency: 'BRL' },
          difference: { amount: '0.00', currency: 'BRL' },
          consistent: true,
          checkedEntries: 42,
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              retryable: { type: 'boolean', description: 'true only for 503: resend with the same Idempotency-Key' },
              details: { type: 'object' },
            },
          },
        },
      },
    },
  },
};
