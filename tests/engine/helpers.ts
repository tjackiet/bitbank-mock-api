import type { Candle } from "../../src/engine/candles.ts";
import type { OpenOrder, PaperState } from "../../src/engine/state.ts";

export function buildState(overrides: Partial<PaperState> = {}): PaperState {
  return {
    version: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    initialJpy: 10_000_000,
    balances: { jpy: 10_000_000 },
    history: [],
    lastTickAt: "2026-01-01T00:00:00.000Z",
    openOrders: [],
    ...overrides,
  };
}

export function buildOrder(overrides: Partial<OpenOrder> = {}): OpenOrder {
  return {
    id: "order-1",
    pair: "btc_jpy",
    side: "buy",
    type: "limit",
    price: 5_000_000,
    amount: 0.001,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function candle(
  ts: number,
  open: number,
  high: number,
  low: number,
  close: number,
  vol = 0,
): Candle {
  return { open, high, low, close, vol, timestamp: ts };
}
