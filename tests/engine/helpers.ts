import type { Candle } from "../../src/engine/candles.ts";
import type { OrderRecord, PaperState, TradeRecord } from "../../src/engine/state.ts";

export function buildState(overrides: Partial<PaperState> = {}): PaperState {
  return {
    version: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    initialJpy: 10_000_000,
    balances: { jpy: 10_000_000 },
    lastTickAt: "2026-01-01T00:00:00.000Z",
    orders: [],
    trades: [],
    nextOrderSeq: 1,
    nextTradeSeq: 1,
    ...overrides,
  };
}

export function buildOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "1",
    pair: "btc_jpy",
    side: "buy",
    type: "limit",
    price: 5_000_000,
    startAmount: 0.001,
    executedAmount: 0,
    executedNotional: 0,
    status: "UNFILLED",
    orderedAt: "2026-01-01T00:00:00.000Z",
    canceledAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function buildTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    tradeId: "1",
    orderId: "1",
    pair: "btc_jpy",
    side: "buy",
    type: "limit",
    amount: 0.001,
    price: 5_000_000,
    feeQuote: 6,
    makerTaker: "maker",
    executedAt: "2026-01-01T00:01:00.000Z",
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
