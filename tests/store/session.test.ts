import { describe, expect, it } from "vitest";
import { activeOrders } from "../../src/engine/state.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { stubFetchCandles } from "../routes/helpers.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;

describe("SessionStore.tick", () => {
  it("fills active orders on every pair in one tick", async () => {
    const state = buildState({
      balances: { jpy: 10_000_000 },
      orders: [
        buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 }),
        buildOrder({ id: "2", pair: "eth_jpy", side: "buy", price: 100, startAmount: 1 }),
      ],
    });
    const store = new SessionStore(state, {
      path: null,
      fillMode: "market",
      fetchCandles: stubFetchCandles({
        btc_jpy: [candle(T0 + MIN, 110, 110, 50, 105)],
        eth_jpy: [candle(T0 + MIN, 110, 110, 50, 105)],
      }),
      feeRate: 0,
    });
    await store.tick(T0 + 2 * MIN);
    expect(activeOrders(store.state())).toHaveLength(0);
    expect(store.state().trades).toHaveLength(2);
  });

  it("does not fetch or fill in manual fillMode", async () => {
    let fetched = 0;
    const store = new SessionStore(
      buildState({
        balances: { jpy: 10_000_000 },
        orders: [buildOrder({ id: "1", side: "buy", price: 100, startAmount: 1 })],
      }),
      {
        path: null,
        fillMode: "manual",
        fetchCandles: async () => {
          fetched += 1;
          return { success: true, data: [candle(T0 + MIN, 110, 110, 50, 105)] };
        },
      },
    );
    await store.tick(T0 + 2 * MIN);
    expect(fetched).toBe(0);
    expect(activeOrders(store.state())).toHaveLength(1);
  });
});
