import { z } from 'zod';
import { EXTERNAL_KINDS } from '../../domain/wager-transaction';

const id = z.string().min(1).max(256);

export const moneySchema = z.object({
  amount: z.string().min(1).max(32),
  currency: z.string().length(3),
});

/** Business payload shared by HTTP body and SQS `data`. Money format is validated by the domain. */
export const wagerPayloadSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    externalTransactionId: id,
    playerId: z.string().min(1).max(128),
    walletId: z.string().uuid(),
    roundId: id,
    gameId: id,
    kind: z.enum(EXTERNAL_KINDS as unknown as [string, ...string[]]),
    money: moneySchema,
    referenceExternalTransactionId: id.optional(),
  })
  .strict();

export const wagerMessageSchema = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime({ offset: true }),
  correlationId: z.string().max(256).optional(),
  data: wagerPayloadSchema.extend({ idempotencyKey: z.string().min(1).max(512) }).strict(),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;
