import { describe, expect, it } from "vitest";
import { buildOrder, buildState } from "../engine/helpers.ts";
import { buildTestServer } from "./helpers.ts";

describe("GET /v1/user/spot/active_orders", () => {
  it("returns open orders", async () => {
    const state = buildState({
      openOrders: [buildOrder({ id: "1" }), buildOrder({ id: "2", pair: "eth_jpy" })],
    });
    const { fastify } = await buildTestServer(state);
    const res = await fastify.inject({ method: "GET", url: "/v1/user/spot/active_orders" });
    const body = res.json() as { success: number; data: { orders: unknown[] } };
    expect(body.success).toBe(1);
    expect(body.data.orders).toHaveLength(2);
  });

  it("filters by pair", async () => {
    const state = buildState({
      openOrders: [buildOrder({ id: "1" }), buildOrder({ id: "2", pair: "eth_jpy" })],
    });
    const { fastify } = await buildTestServer(state);
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/active_orders?pair=eth_jpy",
    });
    const body = res.json() as { success: number; data: { orders: { pair: string }[] } };
    expect(body.data.orders).toHaveLength(1);
    expect(body.data.orders[0].pair).toBe("eth_jpy");
  });
});
