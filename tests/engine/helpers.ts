import type { Candle } from "../../src/engine/candles.ts";
import { issuedSeqOf } from "../../src/engine/state.ts";
import type { OrderRecord, PaperState, TradeRecord } from "../../src/engine/state.ts";

/**
 * 既に居る id のどれとも重ならない採番の初期値（配り得る id の最大 + 1）。
 * `migrateToV3()` と同じ決め方で、判定も同じ `issuedSeqOf()` を使う。
 */
function nextSeqFor(ids: string[]): number {
  return ids.reduce((max, id) => {
    const n = issuedSeqOf(id);
    return n != null && n > max ? n : max;
  }, 0) + 1;
}

/**
 * 既定は空の状態。`orders` / `trades` を渡したときの `nextOrderSeq` / `nextTradeSeq` は、
 * 明示されなければ既存 id より大きい値を自動で入れる。固定の `1` を既定にすると、
 * id `1` の注文を持つ状態が「採番が既存 id を配り直す」前提の破れになり
 * （`preconditionViolations()`）、`loadState()` が読めない状態を組んでしまうため。
 * 採番そのものを見るテストは今までどおり明示して上書きする。
 */
export function buildState(overrides: Partial<PaperState> = {}): PaperState {
  const orders = overrides.orders ?? [];
  const trades = overrides.trades ?? [];
  return {
    version: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    initialJpy: 10_000_000,
    balances: { jpy: 10_000_000 },
    lastTickAt: "2026-01-01T00:00:00.000Z",
    orders: [],
    trades: [],
    nextOrderSeq: nextSeqFor(orders.map((o) => o.id)),
    nextTradeSeq: nextSeqFor(trades.map((t) => t.tradeId)),
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
