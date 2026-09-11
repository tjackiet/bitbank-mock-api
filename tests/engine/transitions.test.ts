import { describe, expect, it } from "vitest";
import { invariantViolations } from "../../src/engine/invariants.ts";
import { remainingOf } from "../../src/engine/state.ts";
import {
  cancelOrder,
  fillOrder,
  placeOrder,
  rejectOrder,
  TransitionError,
} from "../../src/engine/transitions.ts";
import { buildOrder, buildState } from "./helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:01:00.000Z";

describe("placeOrder", () => {
  it("places a limit order as UNFILLED without a trade", () => {
    const r = placeOrder(
      buildState(),
      { pair: "btc_jpy", side: "buy", type: "limit", amount: 0.001, price: 5_000_000 },
      NOW,
      undefined,
      0,
    );
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.id).toBe("1");
    expect(r.data.order.status).toBe("UNFILLED");
    expect(r.data.trade).toBeUndefined();
    expect(r.data.state.nextOrderSeq).toBe(2);
    expect(r.data.state.orders).toHaveLength(1);
    expect(invariantViolations(r.data.state, 0)).toEqual([]);
  });

  it("fills a market order immediately", () => {
    const r = placeOrder(
      buildState({ balances: { jpy: 10_000_000 } }),
      { pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 },
      NOW,
      5_000_000,
      0,
    );
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("FULLY_FILLED");
    expect(r.data.trade?.price).toBe(5_000_000);
    expect(r.data.trade?.tradeId).toBe("1");
    expect(r.data.state.trades).toHaveLength(1);
    expect(r.data.state.balances.btc).toBeCloseTo(0.001, 10);
    expect(invariantViolations(r.data.state, 0)).toEqual([]);
  });

  it("rejects market without a price", () => {
    const r = placeOrder(
      buildState(),
      { pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 },
      NOW,
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(TransitionError.MARKET_PRICE_REQUIRED);
  });

  it("rejects insufficient funds", () => {
    const r = placeOrder(
      buildState({ balances: { jpy: 100 } }),
      { pair: "btc_jpy", side: "buy", type: "limit", amount: 0.001, price: 5_000_000 },
      NOW,
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(TransitionError.INSUFFICIENT_FUNDS);
  });
});

describe("fillOrder", () => {
  it("partial fill moves status to PARTIALLY_FILLED and keeps average", () => {
    const order = buildOrder({ startAmount: 1, price: 100 });
    const state = buildState({ balances: { jpy: 10_000 }, orders: [order] });
    const r = fillOrder(state, order.id, 100, 0.4, LATER, 0);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("PARTIALLY_FILLED");
    expect(r.data.order.executedAmount).toBeCloseTo(0.4, 10);
    expect(remainingOf(r.data.order)).toBeCloseTo(0.6, 10);
    expect(r.data.order.executedNotional / r.data.order.executedAmount).toBe(100);
    expect(invariantViolations(r.data.state, 0)).toEqual([]);
  });

  it("completing remaining amount yields FULLY_FILLED", () => {
    const order = buildOrder({
      startAmount: 1,
      price: 100,
      executedAmount: 0.4,
      executedNotional: 40,
      status: "PARTIALLY_FILLED",
    });
    const state = buildState({
      balances: { jpy: 10_000, btc: 0.4 },
      orders: [order],
      nextTradeSeq: 2,
      trades: [
        {
          tradeId: "1",
          orderId: order.id,
          pair: "btc_jpy",
          side: "buy",
          type: "limit",
          amount: 0.4,
          price: 100,
          feeQuote: 0,
          makerTaker: "maker",
          executedAt: NOW,
        },
      ],
    });
    const r = fillOrder(state, order.id, 100, 0.6, LATER, 0);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("FULLY_FILLED");
    expect(r.data.trade?.tradeId).toBe("2");
    expect(invariantViolations(r.data.state, 0)).toEqual([]);
  });

  it("rejects a worse-than-limit fill price", () => {
    const buy = buildOrder({ side: "buy", price: 100, startAmount: 1 });
    const buyR = fillOrder(buildState({ orders: [buy] }), buy.id, 101, 1, LATER, 0);
    expect(buyR.success).toBe(false);

    const sell = buildOrder({ id: "2", side: "sell", price: 100, startAmount: 1 });
    const sellR = fillOrder(buildState({ orders: [sell] }), sell.id, 99, 1, LATER, 0);
    expect(sellR.success).toBe(false);
  });

  it("rejects amount above remaining and does not mutate", () => {
    const order = buildOrder({ startAmount: 1, price: 100 });
    const state = buildState({ orders: [order] });
    const r = fillOrder(state, order.id, 100, 1.1, LATER, 0);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(TransitionError.INVALID_AMOUNT);
    expect(state.orders[0]?.status).toBe("UNFILLED");
    expect(state.trades).toHaveLength(0);
  });

  it("rejects fill on a terminal order", () => {
    const order = buildOrder({ status: "FULLY_FILLED", startAmount: 1, executedAmount: 1, executedNotional: 100 });
    const snapshot = structuredClone(order);
    const r = fillOrder(buildState({ orders: [order] }), order.id, 100, 1, LATER, 0);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(TransitionError.ORDER_NOT_ACTIVE);
    expect(order).toEqual(snapshot);
  });
});

describe("cancelOrder / rejectOrder", () => {
  it("cancels UNFILLED → CANCELED_UNFILLED", () => {
    const order = buildOrder();
    const r = cancelOrder(buildState({ orders: [order] }), order.id, LATER);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("CANCELED_UNFILLED");
    expect(r.data.order.canceledAt).toBe(LATER);
    expect(invariantViolations(r.data.state)).toEqual([]);
  });

  it("cancels PARTIALLY_FILLED → CANCELED_PARTIALLY_FILLED and keeps executed", () => {
    const order = buildOrder({
      status: "PARTIALLY_FILLED",
      startAmount: 1,
      executedAmount: 0.3,
      executedNotional: 30,
    });
    const state = buildState({
      orders: [order],
      trades: [
        {
          tradeId: "1",
          orderId: order.id,
          pair: "btc_jpy",
          side: "buy",
          type: "limit",
          amount: 0.3,
          price: 100,
          feeQuote: 0,
          makerTaker: "maker",
          executedAt: NOW,
        },
      ],
    });
    const r = cancelOrder(state, order.id, LATER);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("CANCELED_PARTIALLY_FILLED");
    expect(r.data.order.executedAmount).toBe(0.3);
    expect(invariantViolations(r.data.state)).toEqual([]);
  });

  it("refuses to transition a terminal order", () => {
    const order = buildOrder({
      status: "CANCELED_UNFILLED",
      canceledAt: NOW,
    });
    const snapshot = structuredClone(order);
    expect(cancelOrder(buildState({ orders: [order] }), order.id, LATER).success).toBe(false);
    expect(rejectOrder(buildState({ orders: [order] }), order.id, LATER).success).toBe(false);
    expect(order).toEqual(snapshot);
  });

  it("rejectOrder sets REJECTED", () => {
    const order = buildOrder();
    const r = rejectOrder(buildState({ orders: [order] }), order.id, LATER);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("REJECTED");
    expect(invariantViolations(r.data.state)).toEqual([]);
  });
});
