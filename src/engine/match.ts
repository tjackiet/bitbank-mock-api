import type { Candle } from "./candles.ts";
import {
  DEFAULT_TAKER_FEE_RATE,
  type OpenOrder,
  type PaperHistoryEntry,
  type PaperState,
} from "./state.ts";
import { type Logger, noopLogger } from "./types.ts";

const ONE_MIN_MS = 60_000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function applyFill(
  state: PaperState,
  order: OpenOrder,
  candle: Candle,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): { state: PaperState; entry: PaperHistoryEntry } {
  const [base, quote] = order.pair.split("_");
  const balances = { ...state.balances };
  const notional = order.price * order.amount;
  const feeJpy = notional * feeRate;
  if (order.side === "buy") {
    balances[quote] = (balances[quote] ?? 0) - (notional + feeJpy);
    balances[base] = (balances[base] ?? 0) + order.amount;
  } else {
    balances[base] = (balances[base] ?? 0) - order.amount;
    balances[quote] = (balances[quote] ?? 0) + (notional - feeJpy);
  }
  const entry: PaperHistoryEntry = {
    id: order.id,
    pair: order.pair,
    side: order.side,
    type: "limit",
    amount: order.amount,
    fillPrice: order.price,
    feeJpy,
    filledAt: new Date(candle.timestamp + ONE_MIN_MS).toISOString(),
  };
  return {
    state: {
      ...state,
      balances,
      history: [...state.history, entry],
      openOrders: state.openOrders.filter((o) => o.id !== order.id),
    },
    entry,
  };
}

export type RunTickOptions = {
  candles: Candle[];
  nowMs: number;
  feeRate?: number;
  logger?: Logger;
};

export type RunTickResult = {
  state: PaperState;
  filled: PaperHistoryEntry[];
  lastTickAt: string;
};

export function runTick(state: PaperState, opts: RunTickOptions): RunTickResult {
  const { nowMs, candles } = opts;
  const feeRate = opts.feeRate ?? DEFAULT_TAKER_FEE_RATE;
  const logger = opts.logger ?? noopLogger;
  const newLastTickAt = new Date(nowMs).toISOString();
  let fromMs = Math.min(Date.parse(state.lastTickAt), nowMs);
  if (nowMs - fromMs > MAX_LOOKBACK_MS) {
    logger.warn(`gap > 24h; limiting to last 24h (lastTickAt=${state.lastTickAt})`);
    fromMs = nowMs - MAX_LOOKBACK_MS;
  }
  let working: PaperState = { ...state };
  const filled: PaperHistoryEntry[] = [];
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  for (const candle of sorted) {
    if (candle.timestamp < fromMs || candle.timestamp > nowMs) continue;
    const orders = working.openOrders.filter(
      (o) => Date.parse(o.createdAt) <= candle.timestamp,
    );
    for (const o of orders) {
      if (!matches(o, candle)) continue;
      const r = applyFill(working, o, candle, feeRate);
      working = r.state;
      filled.push(r.entry);
    }
  }
  if (filled.length > 0) logger.info(`filled ${filled.length} order(s)`);
  working = { ...working, lastTickAt: newLastTickAt, updatedAt: newLastTickAt };
  return { state: working, filled, lastTickAt: newLastTickAt };
}

function matches(order: OpenOrder, candle: Candle): boolean {
  return order.side === "buy" ? candle.low <= order.price : candle.high >= order.price;
}
