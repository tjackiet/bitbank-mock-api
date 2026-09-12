import { describe, expect, it } from "vitest";
import { activeOrders } from "../../src/engine/state.ts";
import { buildOrder, buildState, buildTrade } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";
import {
  OFFICIAL_CANCEL_ORDER_STATUSES,
  UNIMPLEMENTED_ORDER_FIELDS,
  orderShape,
} from "./official-fields.ts";

describe("POST /v1/user/spot/cancel_order", () => {
  const build = setupBuildTestServer();

  it("cancels an open order", async () => {
    const state = buildState({
      balances: { jpy: 10_000_000 },
      orders: [buildOrder({ id: "123", pair: "btc_jpy" })],
    });
    const { fastify, store } = await build(state);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: 123 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { status: string } };
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("CANCELED_UNFILLED");
    expect(typeof (body.data as { canceled_at?: number }).canceled_at).toBe("number");
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  it("returns 50009 when order not found", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: 999 },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(50009);
  });

  it("returns 50026 when the order is already canceled", async () => {
    const { fastify } = await build(
      buildState({
        orders: [
          buildOrder({
            id: "123",
            status: "CANCELED_UNFILLED",
            canceledAt: "2026-01-01T00:01:00.000Z",
          }),
        ],
      }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: 123 },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(50026);
  });

  it("returns 50027 when the order is already filled", async () => {
    const { fastify } = await build(
      buildState({
        orders: [
          buildOrder({
            id: "123",
            status: "FULLY_FILLED",
            executedAmount: 0.001,
            executedNotional: 5000,
          }),
        ],
        trades: [buildTrade({ tradeId: "1", orderId: "123" })],
      }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: 123 },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(50027);
  });

  it("returns 30006 when order_id is missing", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30006);
  });
});

describe("POST /v1/user/spot/cancel_orders", () => {
  const build = setupBuildTestServer();

  it("cancels multiple", async () => {
    const state = buildState({
      balances: { jpy: 10_000_000 },
      orders: [
        buildOrder({ id: "1" }),
        buildOrder({ id: "2", price: 5_100_000 }),
        buildOrder({ id: "3", price: 5_200_000 }),
      ],
    });
    const { fastify, store } = await build(state);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "btc_jpy", order_ids: [1, 2] },
    });
    const body = res.json() as { success: number; data: { orders: unknown[] } };
    expect(body.success).toBe(1);
    expect(body.data.orders).toHaveLength(2);
    const open = activeOrders(store.state());
    expect(open).toHaveLength(1);
    expect(open[0]?.id).toBe("3");
  });

  it("does not cancel remaining ids when a terminal order is in the batch", async () => {
    const state = buildState({
      orders: [
        buildOrder({
          id: "1",
          status: "CANCELED_UNFILLED",
          canceledAt: "2026-01-01T00:01:00.000Z",
        }),
        buildOrder({ id: "2", price: 5_100_000 }),
      ],
    });
    const { fastify, store } = await build(state);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "btc_jpy", order_ids: [1, 2] },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(50026);
    expect(activeOrders(store.state()).map((o) => o.id)).toEqual(["2"]);
  });

  it("rejects an empty string id before cancelling any order", async () => {
    const state = buildState({
      orders: [buildOrder({ id: "2", price: 5_100_000 })],
    });
    const { fastify, store } = await build(state);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "btc_jpy", order_ids: ["", 2] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(20003);
    expect(activeOrders(store.state()).map((o) => o.id)).toEqual(["2"]);
  });
});

describe("cancel official field set", () => {
  const build = setupBuildTestServer();

  it("POST /v1/user/spot/cancel_order returns exactly the fields the official cancel response defines", async () => {
    // 公式の Cancel order の応答表だけが canceled_at を持つ。取消は必ず起きるので常に出る。
    const { fastify } = await build(
      buildState({ balances: { jpy: 10_000_000 }, orders: [buildOrder({ id: "123" })] }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: 123 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    const s = orderShape(body.data, { type: "limit", canceled: true });
    expect(s.actual).toEqual(s.expected);
    expect(OFFICIAL_CANCEL_ORDER_STATUSES).toContain(body.data.status);
    for (const f of UNIMPLEMENTED_ORDER_FIELDS) expect(body.data).not.toHaveProperty(f);
  });

  it("POST /v1/user/spot/cancel_orders wraps the same objects under `orders`", async () => {
    const { fastify } = await build(
      buildState({
        balances: { jpy: 10_000_000 },
        orders: [buildOrder({ id: "1" }), buildOrder({ id: "2", price: 5_100_000 })],
      }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "btc_jpy", order_ids: [1, 2] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    // 公式の応答は data 直下に orders だけを持つ。
    expect(Object.keys(body.data)).toEqual(["orders"]);
    const orders = body.data.orders as Record<string, unknown>[];
    expect(orders).toHaveLength(2);
    for (const o of orders) {
      const s = orderShape(o, { type: "limit", canceled: true });
      expect(s.actual).toEqual(s.expected);
      expect(OFFICIAL_CANCEL_ORDER_STATUSES).toContain(o.status);
      for (const f of UNIMPLEMENTED_ORDER_FIELDS) expect(o).not.toHaveProperty(f);
    }
  });
});
