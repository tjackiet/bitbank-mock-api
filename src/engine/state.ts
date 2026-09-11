import { z } from "zod";

export const ORDER_STATUSES = [
  "INACTIVE",
  "UNFILLED",
  "PARTIALLY_FILLED",
  "FULLY_FILLED",
  "CANCELED_UNFILLED",
  "CANCELED_PARTIALLY_FILLED",
  "REJECTED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_STATUSES = [
  "FULLY_FILLED",
  "CANCELED_UNFILLED",
  "CANCELED_PARTIALLY_FILLED",
  "REJECTED",
] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const OrderRecordSchema = z.object({
  id: z.string(),
  pair: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["limit", "market"]),
  price: z.number().nullable(),
  startAmount: z.number(),
  executedAmount: z.number(),
  executedNotional: z.number(),
  status: z.enum(ORDER_STATUSES),
  orderedAt: z.string(),
  canceledAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const TradeRecordSchema = z.object({
  tradeId: z.string(),
  orderId: z.string(),
  pair: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["limit", "market"]),
  amount: z.number(),
  price: z.number(),
  feeQuote: z.number(),
  makerTaker: z.enum(["maker", "taker"]),
  executedAt: z.string(),
});

export const PaperStateSchema = z.object({
  version: z.literal(3),
  createdAt: z.string(),
  updatedAt: z.string(),
  initialJpy: z.number(),
  lastTickAt: z.string(),
  balances: z.record(z.string(), z.number()),
  orders: z.array(OrderRecordSchema),
  trades: z.array(TradeRecordSchema),
  nextOrderSeq: z.number().int().positive(),
  nextTradeSeq: z.number().int().positive(),
});

export type OrderRecord = z.infer<typeof OrderRecordSchema>;
export type TradeRecord = z.infer<typeof TradeRecordSchema>;
export type PaperState = z.infer<typeof PaperStateSchema>;

// bitbank 公称テイカー手数料 0.12% (https://bitbank.cc/docs/fees/)
export const DEFAULT_TAKER_FEE_RATE = 0.0012;

export function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

export function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isActive(o: OrderRecord): boolean {
  return o.status === "UNFILLED" || o.status === "PARTIALLY_FILLED";
}

export function isTerminal(o: OrderRecord): boolean {
  return (TERMINAL_STATUSES as readonly OrderStatus[]).includes(o.status);
}

export function activeOrders(state: PaperState): OrderRecord[] {
  return state.orders.filter(isActive);
}

export function remainingOf(o: OrderRecord): number {
  return o.startAmount - o.executedAmount;
}

export function averagePriceOf(o: OrderRecord): number {
  return o.executedAmount === 0 ? 0 : o.executedNotional / o.executedAmount;
}

export function pairAssets(pair: string): [string, string] | null {
  const parts = pair.split("_");
  if (parts.length !== 2) return null;
  const [base, quote] = parts;
  if (!base || !quote || base === quote) return null;
  return [base, quote];
}

export function lockedAssetOf(side: "buy" | "sell", pair: string): string | null {
  const assets = pairAssets(pair);
  if (!assets) return null;
  const [base, quote] = assets;
  return side === "buy" ? quote : base;
}

export function parseNumericId(id: string): number | null {
  if (!/^\d+$/.test(id)) return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

export function computeLocked(
  state: PaperState,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): Record<string, number> {
  const locked: Record<string, number> = {};
  for (const o of activeOrders(state)) {
    const assets = pairAssets(o.pair);
    if (!assets) continue;
    const [base, quote] = assets;
    const remaining = remainingOf(o);
    if (o.side === "buy") {
      if (o.price == null) continue;
      const cost = o.price * remaining * (1 + feeRate);
      locked[quote] = (locked[quote] ?? 0) + cost;
    } else {
      locked[base] = (locked[base] ?? 0) + remaining;
    }
  }
  return locked;
}

export function availableOf(
  state: PaperState,
  asset: string,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): number {
  const total = state.balances[asset] ?? 0;
  const locked = computeLocked(state, feeRate)[asset] ?? 0;
  return total - locked;
}
