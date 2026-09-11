import { z } from "zod";

const numStr = z.coerce.number().finite();
const idValue = z.union([z.number(), z.string()]);

export const CreateOrderRequestSchema = z.object({
  pair: z.string().min(1),
  amount: numStr.refine((n) => n > 0, "amount must be > 0"),
  price: numStr.optional(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]),
});

export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

export const CancelOrderRequestSchema = z.object({
  pair: z.string().min(1),
  order_id: idValue,
});

export const CancelOrdersRequestSchema = z.object({
  pair: z.string().min(1),
  order_ids: z.array(idValue).min(1),
});

export const GetOrderQuerySchema = z.object({
  pair: z.string().min(1),
  order_id: idValue,
});

export const OrdersInfoRequestSchema = z.object({
  pair: z.string().min(1),
  order_ids: z.array(idValue),
});

export const ActiveOrdersQuerySchema = z.object({
  pair: z.string().optional(),
  count: numStr.int().positive().optional(),
  from_id: numStr.optional(),
  end_id: numStr.optional(),
  since: numStr.optional(),
  end: numStr.optional(),
});

export const TradeHistoryQuerySchema = z.object({
  pair: z.string().optional(),
  count: numStr.int().positive().optional(),
  order_id: idValue.optional(),
  since: numStr.optional(),
  end: numStr.optional(),
  order: z.enum(["asc", "desc"]).optional(),
});
