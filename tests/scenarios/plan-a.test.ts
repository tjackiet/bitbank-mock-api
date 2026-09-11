import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildState } from "../engine/helpers.ts";

describe("plan A scenario: place then control fill", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("fills a limit order without fetching market candles", async () => {
    const store = new SessionStore(buildState({ balances: { jpy: 10_000_000 } }), {
      path: null,
      fillMode: "manual",
    });
    const fastify = await buildServer({ store, controlEnabled: true });
    cleanups.push(async () => {
      await fastify.close();
    });

    const placed = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    expect(placed.statusCode).toBe(200);
    const orderId = (placed.json() as { data: { order_id: number } }).data.order_id;

    const before = await fastify.inject({
      method: "GET",
      url: `/v1/user/spot/order?pair=btc_jpy&order_id=${orderId}`,
    });
    const beforeBody = before.json() as {
      data: { status: string; remaining_amount: string; ordered_at: number };
    };
    expect(beforeBody.data.status).toBe("UNFILLED");
    expect(beforeBody.data.remaining_amount).toBe("0.0010");

    const assetsBefore = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    const jpyBefore = (
      assetsBefore.json() as { data: { assets: { asset: string; locked_amount: string; onhand_amount: string }[] } }
    ).data.assets.find((a) => a.asset === "jpy");
    expect(Number(jpyBefore?.locked_amount)).toBeGreaterThan(0);

    const filled = await fastify.inject({
      method: "POST",
      url: `/_control/orders/${orderId}/fill`,
      payload: {},
    });
    expect(filled.statusCode).toBe(200);

    const after = await fastify.inject({
      method: "GET",
      url: `/v1/user/spot/order?pair=btc_jpy&order_id=${orderId}`,
    });
    const afterBody = after.json() as {
      data: {
        status: string;
        executed_amount: string;
        remaining_amount: string;
        average_price: string;
        ordered_at: number;
      };
    };
    expect(afterBody.data.status).toBe("FULLY_FILLED");
    expect(afterBody.data.executed_amount).toBe("0.0010");
    expect(afterBody.data.remaining_amount).toBe("0.0000");
    expect(afterBody.data.average_price).toBe("5000000");
    expect(afterBody.data.ordered_at).toBe(beforeBody.data.ordered_at);

    const assetsAfter = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    const assets = (
      assetsAfter.json() as {
        data: { assets: { asset: string; locked_amount: string; onhand_amount: string }[] };
      }
    ).data.assets;
    const jpyAfter = assets.find((a) => a.asset === "jpy");
    const btcAfter = assets.find((a) => a.asset === "btc");
    expect(Number(jpyAfter?.locked_amount)).toBe(0);
    expect(Number(jpyAfter?.onhand_amount)).toBeLessThan(10_000_000);
    expect(Number(btcAfter?.onhand_amount)).toBe(0.001);
  });
});
