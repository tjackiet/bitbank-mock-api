import { describe, expect, it } from "vitest";
import { buildOrder, buildState } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";

describe("GET /v1/user/spot/active_orders", () => {
  const build = setupBuildTestServer();

  it("returns open orders", async () => {
    const state = buildState({
      orders: [buildOrder({ id: "1" }), buildOrder({ id: "2", pair: "eth_jpy" })],
    });
    const { fastify } = await build(state);
    const res = await fastify.inject({ method: "GET", url: "/v1/user/spot/active_orders" });
    const body = res.json() as { success: number; data: { orders: unknown[] } };
    expect(body.success).toBe(1);
    expect(body.data.orders).toHaveLength(2);
  });

  it("filters by pair", async () => {
    const state = buildState({
      orders: [buildOrder({ id: "1" }), buildOrder({ id: "2", pair: "eth_jpy" })],
    });
    const { fastify } = await build(state);
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/active_orders?pair=eth_jpy",
    });
    const body = res.json() as { success: number; data: { orders: { pair: string }[] } };
    expect(body.data.orders).toHaveLength(1);
    expect(body.data.orders[0].pair).toBe("eth_jpy");
  });

  it("filters by from_id, since, and count", async () => {
    const state = buildState({
      orders: [
        buildOrder({ id: "1", orderedAt: "2026-01-01T00:00:00.000Z" }),
        buildOrder({ id: "2", price: 5_100_000, orderedAt: "2026-01-01T00:02:00.000Z" }),
        buildOrder({ id: "3", price: 5_200_000, orderedAt: "2026-01-01T00:03:00.000Z" }),
      ],
    });
    const { fastify } = await build(state);
    const res = await fastify.inject({
      method: "GET",
      url: `/v1/user/spot/active_orders?from_id=2&since=${Date.parse("2026-01-01T00:02:00.000Z")}&count=1`,
    });
    const body = res.json() as { data: { orders: { order_id: number }[] } };
    expect(body.data.orders).toHaveLength(1);
    expect(body.data.orders[0]?.order_id).toBe(2);
  });
});
