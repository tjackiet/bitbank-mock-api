import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { invariantViolations } from "../../src/engine/invariants.ts";
import { activeOrders, isTerminal, remainingOf, type PaperState } from "../../src/engine/state.ts";
import { cancelOrder, fillOrder, placeOrder, rejectOrder } from "../../src/engine/transitions.ts";
import { buildOrder, buildState, buildTrade } from "./helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function applyRandomOp(state: PaperState, kind: number, a: number, b: number): PaperState {
  const at = NOW;
  const feeRate = 0;
  const k = Math.abs(kind) % 5;
  if (k === 0) {
    const amount = Math.round((0.001 + (a % 50) / 10000) * 10000) / 10000;
    const price = 1000 + (b % 200);
    const r = placeOrder(
      state,
      { pair: "btc_jpy", side: "buy", type: "limit", amount, price },
      at,
      undefined,
      feeRate,
    );
    return r.success ? r.data.state : state;
  }
  if (k === 1) {
    const amount = Math.round((0.001 + (a % 20) / 10000) * 10000) / 10000;
    const price = 1000 + (b % 200);
    const r = placeOrder(
      state,
      { pair: "btc_jpy", side: "sell", type: "limit", amount, price },
      at,
      undefined,
      feeRate,
    );
    return r.success ? r.data.state : state;
  }
  const open = activeOrders(state);
  if (open.length === 0) return state;
  const target = open[Math.abs(a) % open.length];
  if (!target) return state;
  if (k === 2) {
    const rem = remainingOf(target);
    const frac = 0.25 + (Math.abs(b) % 4) * 0.25;
    const amount = Math.round(rem * frac * 10000) / 10000;
    const px = target.price ?? 1000;
    const r = fillOrder(state, target.id, px, amount > 0 ? Math.min(amount, rem) : rem, at, feeRate);
    return r.success ? r.data.state : state;
  }
  if (k === 3) {
    const r = cancelOrder(state, target.id, at);
    return r.success ? r.data.state : state;
  }
  const r = rejectOrder(state, target.id, at);
  return r.success ? r.data.state : state;
}

describe("invariants", () => {
  it("hold on a fresh state", () => {
    expect(invariantViolations(buildState({ balances: { jpy: 10_000_000, btc: 1 } }), 0)).toEqual([]);
  });

  it("flags canceled statuses that do not match executed amount", () => {
    const unfilled = buildOrder({
      status: "CANCELED_UNFILLED",
      executedAmount: 0.1,
      executedNotional: 10,
    });
    expect(invariantViolations(buildState({ orders: [unfilled] }))).not.toEqual([]);
    const partial = buildOrder({
      status: "CANCELED_PARTIALLY_FILLED",
      executedAmount: 0,
      executedNotional: 0,
    });
    expect(invariantViolations(buildState({ orders: [partial] }))).not.toEqual([]);
  });

  it("flags trades without an order", () => {
    const state = buildState({ trades: [buildTrade({ orderId: "missing" })] });
    expect(invariantViolations(state).some((v) => v.includes("has no order"))).toBe(true);
  });

  it("hold after random place/fill/cancel/reject sequences", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer(), fc.integer(), fc.integer()), {
          minLength: 1,
          maxLength: 40,
        }),
        (ops) => {
          let state = buildState({ balances: { jpy: 10_000_000, btc: 1 } });
          const terminals = new Map<string, string>();
          for (const [kind, a, b] of ops) {
            const before = new Map(state.orders.filter(isTerminal).map((o) => [o.id, JSON.stringify(o)]));
            state = applyRandomOp(state, kind, a, b);
            expect(invariantViolations(state, 0)).toEqual([]);
            for (const [id, snap] of before) {
              const after = state.orders.find((o) => o.id === id);
              expect(after && JSON.stringify(after)).toBe(snap);
            }
            for (const o of state.orders) {
              if (isTerminal(o)) {
                terminals.set(o.id, JSON.stringify(o));
              }
            }
          }
          for (const [id, snap] of terminals) {
            const after = state.orders.find((o) => o.id === id);
            expect(after && JSON.stringify(after)).toBe(snap);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
