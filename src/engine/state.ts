import { z } from "zod";

export const PaperHistoryEntrySchema = z.object({
  id: z.string(),
  pair: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]),
  amount: z.number(),
  fillPrice: z.number(),
  feeJpy: z.number(),
  filledAt: z.string(),
});

export const OpenOrderSchema = z.object({
  id: z.string(),
  pair: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.literal("limit"),
  price: z.number(),
  amount: z.number(),
  createdAt: z.string(),
});

export const PaperStateSchema = z.object({
  version: z.literal(2),
  createdAt: z.string(),
  updatedAt: z.string(),
  initialJpy: z.number(),
  balances: z.record(z.string(), z.number()),
  history: z.array(PaperHistoryEntrySchema),
  lastTickAt: z.string(),
  openOrders: z.array(OpenOrderSchema),
});

export type PaperState = z.infer<typeof PaperStateSchema>;
export type PaperHistoryEntry = z.infer<typeof PaperHistoryEntrySchema>;
export type OpenOrder = z.infer<typeof OpenOrderSchema>;

// bitbank 公称テイカー手数料 0.12% (https://bitbank.cc/docs/fees/)
export const DEFAULT_TAKER_FEE_RATE = 0.0012;

export function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

export function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function computeLocked(
  state: PaperState,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): Record<string, number> {
  const locked: Record<string, number> = {};
  for (const o of state.openOrders) {
    const [base, quote] = o.pair.split("_");
    if (o.side === "buy") {
      const cost = o.price * o.amount * (1 + feeRate);
      locked[quote] = (locked[quote] ?? 0) + cost;
    } else {
      locked[base] = (locked[base] ?? 0) + o.amount;
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
