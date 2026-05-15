import { describe, expect, it } from "vitest";
import { buildOrder, buildState } from "../engine/helpers.ts";
import { buildTestServer } from "./helpers.ts";

describe("POST /v1/user/spot/cancel_order", () => {
  it("cancels an open order", async () => {
    const state = buildState({
      balances: { jpy: 10_000_000 },
      openOrders: [buildOrder({ id: "123", pair: "btc_jpy" })],
    });
    const { fastify, store } = await buildTestServer(state);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: 123 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { status: string } };
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("CANCELED_UNFILLED");
    expect(store.state().openOrders).toHaveLength(0);
  });

  it("returns 50009 when order not found", async () => {
    const { fastify } = await buildTestServer();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: 999 },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(50009);
  });
});

describe("POST /v1/user/spot/cancel_orders", () => {
  it("cancels multiple", async () => {
    const state = buildState({
      balances: { jpy: 10_000_000 },
      openOrders: [
        buildOrder({ id: "1" }),
        buildOrder({ id: "2", price: 5_100_000 }),
        buildOrder({ id: "3", price: 5_200_000 }),
      ],
    });
    const { fastify, store } = await buildTestServer(state);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "btc_jpy", order_ids: [1, 2] },
    });
    const body = res.json() as { success: number; data: { orders: unknown[] } };
    expect(body.success).toBe(1);
    expect(body.data.orders).toHaveLength(2);
    expect(store.state().openOrders).toHaveLength(1);
    expect(store.state().openOrders[0].id).toBe("3");
  });
});
