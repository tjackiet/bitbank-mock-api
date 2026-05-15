import { z } from "zod";

const numStr = z.union([z.number(), z.string().transform((s) => Number(s))]);

export const CreateOrderRequestSchema = z.object({
  pair: z.string().min(1),
  amount: numStr.refine((n) => Number.isFinite(n) && n > 0, "amount must be > 0"),
  price: numStr.optional(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]),
});

export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

export const CancelOrderRequestSchema = z.object({
  pair: z.string().min(1),
  order_id: z.union([z.number(), z.string()]),
});

export const CancelOrdersRequestSchema = z.object({
  pair: z.string().min(1),
  order_ids: z.array(z.union([z.number(), z.string()])).min(1),
});

export const ActiveOrdersQuerySchema = z.object({
  pair: z.string().optional(),
});

export const TradeHistoryQuerySchema = z.object({
  pair: z.string().optional(),
  count: numStr.optional(),
});
