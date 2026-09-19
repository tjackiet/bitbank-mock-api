import { describe, expect, it } from "vitest";
import type { RunTickOptions } from "../../src/engine/match.ts";
import { applyFill, runTick } from "../../src/engine/match.ts";
import type { PaperState } from "../../src/engine/state.ts";
import { activeOrders } from "../../src/engine/state.ts";
import type { Logger } from "../../src/engine/types.ts";
import { buildOrder, buildState, candle } from "./helpers.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;

function tickOk(state: PaperState, opts: RunTickOptions) {
  const r = runTick(state, opts);
  expect(r.success).toBe(true);
  if (!r.success) throw new Error(r.error);
  return r.data;
}

function fillOk(...args: Parameters<typeof applyFill>) {
  const r = applyFill(...args);
  expect(r.success).toBe(true);
  if (!r.success) throw new Error(r.error);
  return r.data;
}

describe("applyFill", () => {
  it("buy: decreases quote (incl fee), increases base", () => {
    const order = buildOrder({ side: "buy", price: 100_000, startAmount: 1 });
    const state = buildState({ balances: { jpy: 1_000_000 }, orders: [order] });
    const c = candle(T0, 100_000, 100_000, 100_000, 100_000);
    const r = fillOk(state, order.id, c, 0.001);
    expect(r.state.balances.jpy).toBeCloseTo(1_000_000 - 100_000 - 100, 6);
    expect(r.state.balances.btc).toBeCloseTo(1, 6);
    expect(r.trade.feeQuote).toBeCloseTo(100, 6);
    expect(activeOrders(r.state)).toHaveLength(0);
    expect(r.state.trades).toHaveLength(1);
  });

  it("sell: decreases base, increases quote (net of fee)", () => {
    const order = buildOrder({ side: "sell", price: 100_000, startAmount: 1 });
    const state = buildState({ balances: { jpy: 0, btc: 1 }, orders: [order] });
    const c = candle(T0, 100_000, 100_000, 100_000, 100_000);
    const r = fillOk(state, order.id, c, 0.001);
    expect(r.state.balances.btc).toBeCloseTo(0, 6);
    expect(r.state.balances.jpy).toBeCloseTo(100_000 - 100, 6);
  });

  it("filledAt = candle.timestamp + 1min (close of bar)", () => {
    const order = buildOrder();
    const c = candle(T0, 1, 1, 1, 1);
    const r = fillOk(buildState({ orders: [order] }), order.id, c, 0);
    expect(r.trade.executedAt).toBe(new Date(T0 + MIN).toISOString());
  });

  // 以下 3 本は「throw せず Result を返す」こと自体の固定。throw に戻ると
  // `SessionStore.tick()` 経由で互換ルートが封筒でない 500 を返すようになる。
  it("不在の注文は throw せず失敗を返す", () => {
    const r = applyFill(buildState({ orders: [] }), "nope", candle(T0, 1, 1, 1, 1), 0);
    expect(r).toEqual({ success: false, error: 'applyFill: order "nope" not found' });
  });

  it("採番を使い切っていたら throw せず失敗を返す", () => {
    const order = buildOrder({ side: "buy", price: 100_000, startAmount: 1 });
    const state = buildState({
      balances: { jpy: 1_000_000 },
      orders: [order],
      nextTradeSeq: Number.MAX_SAFE_INTEGER + 1,
    });
    const r = applyFill(state, order.id, candle(T0, 100_000, 100_000, 100_000, 100_000), 0);
    expect(r).toEqual({ success: false, error: "applyFill: TRADE_SEQ_EXHAUSTED" });
  });

  it("残量 0 の active な注文は throw せず失敗を返す（startAmount == 0）", () => {
    const order = buildOrder({ side: "buy", price: 100_000, startAmount: 0 });
    const state = buildState({ balances: { jpy: 1_000_000 }, orders: [order] });
    const r = applyFill(state, order.id, candle(T0, 100_000, 100_000, 100_000, 100_000), 0);
    expect(r).toEqual({ success: false, error: "applyFill: INVALID_AMOUNT" });
  });

  it("注文 id は JSON で包んでメッセージに載せる（ログの行を割らせない）", () => {
    const r = applyFill(buildState({ orders: [] }), "a\nb", candle(T0, 1, 1, 1, 1), 0);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).not.toContain("\n");
    expect(r.error).toContain('"a\\nb"');
  });
});

describe("runTick fill judgment", () => {
  it("buy fills when candle.low <= price", () => {
    const state = buildState({
      orders: [buildOrder({ side: "buy", price: 100, startAmount: 1 })],
      balances: { jpy: 10_000 },
    });
    const r = tickOk(state, {
      candles: [candle(T0 + MIN, 110, 110, 99, 105)],
      nowMs: T0 + 2 * MIN,
      feeRate: 0,
    });
    expect(r.filled).toHaveLength(1);
    expect(activeOrders(r.state)).toHaveLength(0);
  });

  it("buy does NOT fill when candle.low > price", () => {
    const state = buildState({
      orders: [buildOrder({ side: "buy", price: 100, startAmount: 1 })],
    });
    const r = tickOk(state, {
      candles: [candle(T0 + MIN, 110, 120, 105, 115)],
      nowMs: T0 + 2 * MIN,
      feeRate: 0,
    });
    expect(r.filled).toHaveLength(0);
    expect(activeOrders(r.state)).toHaveLength(1);
  });

  it("sell fills when candle.high >= price", () => {
    const state = buildState({
      balances: { jpy: 0, btc: 1 },
      orders: [buildOrder({ side: "sell", price: 100, startAmount: 1 })],
    });
    const r = tickOk(state, {
      candles: [candle(T0 + MIN, 90, 101, 80, 95)],
      nowMs: T0 + 2 * MIN,
      feeRate: 0,
    });
    expect(r.filled).toHaveLength(1);
  });

  it("ignores candles older than order.orderedAt", () => {
    const state = buildState({
      orders: [
        buildOrder({
          orderedAt: new Date(T0 + 5 * MIN).toISOString(),
          side: "buy",
          price: 100,
          startAmount: 1,
        }),
      ],
    });
    const r = tickOk(state, {
      candles: [candle(T0 + MIN, 110, 110, 50, 105)],
      nowMs: T0 + 10 * MIN,
      feeRate: 0,
    });
    expect(r.filled).toHaveLength(0);
  });

  it("advances lastTickAt to nowMs even when nothing fills", () => {
    const r = tickOk(buildState(), {
      candles: [],
      nowMs: T0 + 10 * MIN,
      feeRate: 0,
    });
    expect(r.lastTickAt).toBe(new Date(T0 + 10 * MIN).toISOString());
    expect(r.state.lastTickAt).toBe(r.lastTickAt);
  });

  it("warns when gap > 24h", () => {
    const warnings: string[] = [];
    const logger: Logger = { warn: (m) => warnings.push(m), info: () => {} };
    const state = buildState({ lastTickAt: new Date(T0).toISOString() });
    tickOk(state, {
      candles: [],
      nowMs: T0 + 48 * 60 * MIN,
      feeRate: 0,
      logger,
    });
    expect(warnings.some((w) => w.includes("gap > 24h"))).toBe(true);
  });

  it("filters candles outside [fromMs, nowMs]", () => {
    const state = buildState({
      lastTickAt: new Date(T0 + 5 * MIN).toISOString(),
      orders: [buildOrder({ side: "buy", price: 100, startAmount: 1 })],
    });
    const r = tickOk(state, {
      candles: [
        candle(T0 + MIN, 110, 110, 50, 105),
        candle(T0 + 10 * MIN, 110, 110, 50, 105),
        candle(T0 + 999 * MIN, 110, 110, 50, 105),
      ],
      nowMs: T0 + 20 * MIN,
      feeRate: 0,
    });
    expect(r.filled).toHaveLength(1);
  });

  it("logs info when at least one order fills", () => {
    const infos: string[] = [];
    const logger: Logger = { warn: () => {}, info: (m) => infos.push(m) };
    const state = buildState({
      orders: [buildOrder({ side: "buy", price: 100, startAmount: 1 })],
    });
    tickOk(state, {
      candles: [candle(T0 + MIN, 110, 110, 50, 105)],
      nowMs: T0 + 2 * MIN,
      feeRate: 0,
      logger,
    });
    expect(infos.some((m) => m.includes("filled"))).toBe(true);
  });

  it("rejects invalid candles without mutating state", () => {
    const state = buildState({
      orders: [buildOrder({ side: "buy", price: 100, startAmount: 1 })],
    });
    const r = runTick(state, {
      candles: [candle(T0 + MIN, 110, Number.POSITIVE_INFINITY, 50, 105)],
      nowMs: T0 + 2 * MIN,
      feeRate: 0,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toBe("INVALID_CANDLE");
    expect(activeOrders(state)).toHaveLength(1);
  });
});
