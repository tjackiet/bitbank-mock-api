import { describe, expect, it } from "vitest";
import { applyFill, runTick } from "../../src/engine/match.ts";
import type { Logger } from "../../src/engine/types.ts";
import { buildOrder, buildState, candle } from "./helpers.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;

describe("applyFill", () => {
  it("buy: decreases quote (incl fee), increases base", () => {
    const state = buildState({ balances: { jpy: 1_000_000 } });
    const order = buildOrder({ side: "buy", price: 100_000, amount: 1 });
    const c = candle(T0, 100_000, 100_000, 100_000, 100_000);
    const r = applyFill(state, order, c, 0.001);
    expect(r.state.balances.jpy).toBeCloseTo(1_000_000 - 100_000 - 100, 6);
    expect(r.state.balances.btc).toBeCloseTo(1, 6);
    expect(r.entry.feeJpy).toBeCloseTo(100, 6);
    expect(r.state.openOrders).toHaveLength(0);
    expect(r.state.history).toHaveLength(1);
  });

  it("sell: decreases base, increases quote (net of fee)", () => {
    const state = buildState({ balances: { jpy: 0, btc: 1 } });
    const order = buildOrder({ side: "sell", price: 100_000, amount: 1 });
    const c = candle(T0, 100_000, 100_000, 100_000, 100_000);
    const r = applyFill(state, order, c, 0.001);
    expect(r.state.balances.btc).toBeCloseTo(0, 6);
    expect(r.state.balances.jpy).toBeCloseTo(100_000 - 100, 6);
  });

  it("filledAt = candle.timestamp + 1min (close of bar)", () => {
    const order = buildOrder();
    const c = candle(T0, 1, 1, 1, 1);
    const r = applyFill(buildState(), order, c, 0);
    expect(r.entry.filledAt).toBe(new Date(T0 + MIN).toISOString());
  });
});

describe("runTick fill judgment", () => {
  it("buy fills when candle.low <= price", () => {
    const state = buildState({
      openOrders: [buildOrder({ side: "buy", price: 100, amount: 1 })],
      balances: { jpy: 10_000 },
    });
    const r = runTick(state, {
      candles: [candle(T0 + MIN, 110, 110, 99, 105)],
      nowMs: T0 + 2 * MIN,
      feeRate: 0,
    });
    expect(r.filled).toHaveLength(1);
    expect(r.state.openOrders).toHaveLength(0);
  });

  it("buy does NOT fill when candle.low > price", () => {
    const state = buildState({
      openOrders: [buildOrder({ side: "buy", price: 100, amount: 1 })],
    });
    const r = runTick(state, {
      candles: [candle(T0 + MIN, 110, 120, 105, 115)],
      nowMs: T0 + 2 * MIN,
      feeRate: 0,
    });
    expect(r.filled).toHaveLength(0);
    expect(r.state.openOrders).toHaveLength(1);
  });

  it("sell fills when candle.high >= price", () => {
    const state = buildState({
      balances: { jpy: 0, btc: 1 },
      openOrders: [buildOrder({ side: "sell", price: 100, amount: 1 })],
    });
    const r = runTick(state, {
      candles: [candle(T0 + MIN, 90, 101, 80, 95)],
      nowMs: T0 + 2 * MIN,
      feeRate: 0,
    });
    expect(r.filled).toHaveLength(1);
  });

  it("ignores candles older than order.createdAt", () => {
    const state = buildState({
      openOrders: [
        buildOrder({
          createdAt: new Date(T0 + 5 * MIN).toISOString(),
          side: "buy",
          price: 100,
          amount: 1,
        }),
      ],
    });
    const r = runTick(state, {
      candles: [candle(T0 + MIN, 110, 110, 50, 105)],
      nowMs: T0 + 10 * MIN,
      feeRate: 0,
    });
    expect(r.filled).toHaveLength(0);
  });

  it("advances lastTickAt to nowMs even when nothing fills", () => {
    const r = runTick(buildState(), {
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
    runTick(state, {
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
      openOrders: [buildOrder({ side: "buy", price: 100, amount: 1 })],
    });
    const r = runTick(state, {
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
      openOrders: [buildOrder({ side: "buy", price: 100, amount: 1 })],
    });
    runTick(state, {
      candles: [candle(T0 + MIN, 110, 110, 50, 105)],
      nowMs: T0 + 2 * MIN,
      feeRate: 0,
      logger,
    });
    expect(infos.some((m) => m.includes("filled"))).toBe(true);
  });
});
