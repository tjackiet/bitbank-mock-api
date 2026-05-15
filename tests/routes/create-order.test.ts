import { describe, expect, it } from "vitest";
import { buildState, candle } from "../engine/helpers.ts";
import { buildTestServer } from "./helpers.ts";

describe("POST /v1/user/spot/order", () => {
  it("creates a limit buy and adds to open orders", async () => {
    const { fastify, store } = await buildTestServer(
      buildState({ balances: { jpy: 10_000_000 } }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { order_id: number; status: string } };
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("UNFILLED");
    expect(store.state().openOrders).toHaveLength(1);
  });

  it("rejects limit buy when funds insufficient", async () => {
    const { fastify } = await buildTestServer(buildState({ balances: { jpy: 100 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(50008);
  });

  it("fills market buy at latest candle close", async () => {
    const now = Date.now();
    const { fastify, store } = await buildTestServer(
      buildState({ balances: { jpy: 10_000_000 } }),
      { btc_jpy: [candle(now - 60_000, 4_990_000, 5_010_000, 4_980_000, 5_000_000)] },
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", side: "buy", type: "market" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { status: string; price: string } };
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("FULLY_FILLED");
    expect(Number(body.data.price)).toBe(5_000_000);
    expect(store.state().balances.btc).toBe(0.001);
    expect(store.state().history).toHaveLength(1);
  });

  it("rejects invalid pair", async () => {
    const { fastify } = await buildTestServer();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number };
    expect(body.success).toBe(0);
  });

  it("rejects bad payload", async () => {
    const { fastify } = await buildTestServer();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "-1", side: "buy", type: "limit", price: "5000000" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(20003);
  });
});
