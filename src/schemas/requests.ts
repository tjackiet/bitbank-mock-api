import { z } from "zod";

const numStr = z.coerce.number().finite();
const idValue = z.union([z.number(), z.string().min(1)]);

/**
 * クエリの数値。**空文字を「未指定」や `0` として扱わない。**
 *
 * `z.coerce.number()` は `""` を `0` にするので、そのまま使うと `?end=` が
 * 「`0` 以下だけを残す」絞り込みになり、**`success: 1` で常に空配列**を返していた。
 * 実 API は空文字をパラメータごとの専用コードで弾く（実測 2026-09-16、`btc_jpy`）。
 *
 * | 要求 | 実 API | 旧モック |
 * | --- | --- | --- |
 * | `active_orders?count=` | `40006` | `20003` |
 * | `active_orders?end=` | `40007` | `success: 1` で 0 件 |
 * | `trade_history?since=` | `40022` | `success: 1` で素通り |
 *
 * coerce の前に空文字を `NaN` へ落として `finite()` で弾く。本文側の `numStr` は
 * 変えない（欠落は `isMissing()` が先に `3000x` で拾うため、空文字はここへ来ない）。
 */
const queryNum = z.preprocess((v) => (v === "" ? Number.NaN : v), z.coerce.number().finite());
const queryCount = queryNum.pipe(z.number().int().positive());

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
  count: queryCount.optional(),
  from_id: queryNum.optional(),
  end_id: queryNum.optional(),
  since: queryNum.optional(),
  end: queryNum.optional(),
});

export const TradeHistoryQuerySchema = z.object({
  pair: z.string().optional(),
  count: queryCount.optional(),
  order_id: idValue.optional(),
  since: queryNum.optional(),
  end: queryNum.optional(),
  order: z.enum(["asc", "desc"]).optional(),
});
