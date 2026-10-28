import { EntitySchema } from '@mikro-orm/core';

/**
 * Persistence records (MikroORM EntitySchema — no decorators, so the domain stays ORM-free).
 * They are *rows*, not aggregates: repositories map them to/from domain objects via `rehydrate`.
 * Money columns are `numeric(20,2)` mapped as `decimal` → JS string (never number).
 */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'decimal', columnType: 'numeric(20,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    updatedAt: { type: 'Date', fieldName: 'updated_at' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultBalance?: string | null;
  resultCurrency?: string | null;
  referenceAttempts!: number;
  nextReferenceCheckAt?: Date | null;
  processedAt?: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash', columnType: 'char(64)' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'string', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    amount: { type: 'decimal', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', fieldName: 'reference_external_transaction_id', nullable: true },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    resultBalance: { type: 'decimal', fieldName: 'result_balance', columnType: 'numeric(20,2)', nullable: true },
    resultCurrency: { type: 'string', fieldName: 'result_currency', columnType: 'char(3)', nullable: true },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts' },
    nextReferenceCheckAt: { type: 'Date', fieldName: 'next_reference_check_at', nullable: true },
    processedAt: { type: 'Date', fieldName: 'processed_at', nullable: true },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    updatedAt: { type: 'Date', fieldName: 'updated_at' },
  },
});

export class LedgerEntryRecord {
  sequence!: string;
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    sequence: { type: 'bigint', autoincrement: true },
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: { type: 'decimal', columnType: 'numeric(20,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { type: 'decimal', fieldName: 'balance_before', columnType: 'numeric(20,2)' },
    balanceAfter: { type: 'decimal', fieldName: 'balance_after', columnType: 'numeric(20,2)' },
    createdAt: { type: 'Date', fieldName: 'created_at' },
  },
});

export const ENTITIES = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema];
