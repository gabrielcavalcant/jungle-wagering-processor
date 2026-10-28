import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted lexicographically (recursively), no whitespace,
 * `undefined` members dropped. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Business fields that define "the same request". Transport metadata (headers, messageId) is excluded. */
export interface HashableWagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** `sha256(canonicalJson(subset))` as lowercase hex. Money is hashed in its normalized "25.00" form. */
export function hashWagerPayload(p: HashableWagerPayload): string {
  const subset = {
    providerId: p.providerId,
    externalTransactionId: p.externalTransactionId,
    playerId: p.playerId,
    walletId: p.walletId,
    roundId: p.roundId,
    gameId: p.gameId,
    kind: p.kind,
    money: { amount: p.money.amount, currency: p.money.currency },
    referenceExternalTransactionId: p.referenceExternalTransactionId,
  };
  return sha256(canonicalJson(subset));
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
