import type { Candle } from "./candles.ts";
import { remainingOf, type OrderRecord, type PaperState, type TradeRecord } from "./state.ts";
import { DEFAULT_TAKER_FEE_RATE } from "./state.ts";
import { fillOrder } from "./transitions.ts";
import { type Logger, noopLogger } from "./types.ts";

const ONE_MIN_MS = 60_000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function applyFill(
  state: PaperState,
  orderId: string,
  candle: Candle,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): { state: PaperState; trade: TradeRecord } {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) throw new Error(`applyFill: order ${orderId} not found`);
  if (order.price == null) throw new Error(`applyFill: order ${orderId} has no limit price`);
  const at = new Date(candle.timestamp + ONE_MIN_MS).toISOString();
  const r = fillOrder(state, orderId, order.price, remainingOf(order), at, feeRate);
  if (!r.success || !r.data.trade) throw new Error(`applyFill: ${"error" in r ? r.error : "missing trade"}`);
  return { state: r.data.state, trade: r.data.trade };
}

export type RunTickOptions = {
  candles: Candle[];
  nowMs: number;
  pair?: string;
  feeRate?: number;
  logger?: Logger;
};

export type RunTickResult = {
  state: PaperState;
  filled: TradeRecord[];
  lastTickAt: string;
};

export function runTick(state: PaperState, opts: RunTickOptions): RunTickResult {
  const { nowMs, candles, pair } = opts;
  const feeRate = opts.feeRate ?? DEFAULT_TAKER_FEE_RATE;
  const logger = opts.logger ?? noopLogger;
  const newLastTickAt = new Date(nowMs).toISOString();
  let fromMs = Math.min(Date.parse(state.lastTickAt), nowMs);
  if (nowMs - fromMs > MAX_LOOKBACK_MS) {
    logger.warn(`gap > 24h; limiting to last 24h (lastTickAt=${state.lastTickAt})`);
    fromMs = nowMs - MAX_LOOKBACK_MS;
  }
  let working: PaperState = { ...state };
  const filled: TradeRecord[] = [];
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  for (const candle of sorted) {
    if (candle.timestamp < fromMs || candle.timestamp > nowMs) continue;
    const orders = working.orders.filter(
      (o) =>
        (o.status === "UNFILLED" || o.status === "PARTIALLY_FILLED") &&
        (!pair || o.pair === pair) &&
        Date.parse(o.orderedAt) <= candle.timestamp,
    );
    for (const o of orders) {
      if (!matches(o, candle)) continue;
      const r = applyFill(working, o.id, candle, feeRate);
      working = r.state;
      filled.push(r.trade);
    }
  }
  if (filled.length > 0) logger.info(`filled ${filled.length} order(s)`);
  working = { ...working, lastTickAt: newLastTickAt, updatedAt: newLastTickAt };
  return { state: working, filled, lastTickAt: newLastTickAt };
}

function matches(order: OrderRecord, candle: Candle): boolean {
  if (order.price == null) return false;
  return order.side === "buy" ? candle.low <= order.price : candle.high >= order.price;
}
