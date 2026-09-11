import { describe, expect, it } from "vitest";
import { formatAveragePrice, formatOrder } from "../../src/routes/format.ts";
import { priceUnit } from "../../src/engine/precision.ts";
import { fillOrder } from "../../src/engine/transitions.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";

type OrderBody = {
  order_id: number;
  status: string;
  executed_amount: string;
  remaining_amount: string;
  average_price: string;
  ordered_at: number;
  user_cancelable: boolean;
  expire_at: null;
  post_only?: boolean;
  price?: string;
  canceled_at?: number;
  start_amount: string;
};

type Envelope<T> = { success: number; data: T };

describe("GET /v1/user/spot/order", () => {
  const build = setupBuildTestServer();

  it("returns an unfilled limit order with stable ordered_at", async () => {
    const orderedAt = "2026-01-01T00:00:00.000Z";
    const { fastify } = await build(
      buildState({
        orders: [buildOrder({ id: "1", orderedAt })],
      }),
    );
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=btc_jpy&order_id=1",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Envelope<OrderBody>;
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("UNFILLED");
    expect(body.data.executed_amount).toBe("0.0000");
    expect(body.data.remaining_amount).toBe("0.0010");
    expect(body.data.average_price).toBe("0");
    expect(body.data.ordered_at).toBe(Date.parse(orderedAt));
    expect(body.data.user_cancelable).toBe(true);
    expect(body.data.post_only).toBe(false);
    expect(body.data.expire_at).toBeNull();
    expect(body.data.canceled_at).toBeUndefined();
  });

  it("returns a filled limit order without changing ordered_at", async () => {
    const now = Date.now();
    const orderedAt = new Date(now - 120_000).toISOString();
    const t0 = Date.parse(orderedAt);
    const { fastify } = await build(
      buildState({
        balances: { jpy: 10_000_000 },
        lastTickAt: orderedAt,
        orders: [buildOrder({ id: "1", orderedAt, price: 5_000_000, startAmount: 0.001 })],
      }),
      { btc_jpy: [candle(now - 60_000, 4_990_000, 5_010_000, 4_980_000, 5_000_000)] },
    );
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=btc_jpy&order_id=1",
    });
    const body = res.json() as Envelope<OrderBody>;
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("FULLY_FILLED");
    expect(body.data.executed_amount).toBe("0.0010");
    expect(body.data.remaining_amount).toBe("0.0000");
    expect(body.data.average_price).toBe("5000000");
    expect(body.data.ordered_at).toBe(t0);
    expect(body.data.user_cancelable).toBe(false);
    expect(Number(body.data.executed_amount) * Number(body.data.average_price)).toBe(5000);
  });

  it("returns a canceled limit order with canceled_at", async () => {
    const { fastify } = await build(
      buildState({
        orders: [
          buildOrder({
            id: "1",
            status: "CANCELED_UNFILLED",
            canceledAt: "2026-01-01T00:01:00.000Z",
          }),
        ],
      }),
    );
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=btc_jpy&order_id=1",
    });
    const body = res.json() as Envelope<OrderBody>;
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("CANCELED_UNFILLED");
    expect(body.data.canceled_at).toBe(Date.parse("2026-01-01T00:01:00.000Z"));
    expect(body.data.user_cancelable).toBe(false);
    expect(body.data.executed_amount).toBe("0.0000");
    expect(body.data.average_price).toBe("0");
  });

  it("returns a market order without a price field", async () => {
    const now = Date.now();
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000 } }), {
      btc_jpy: [candle(now - 60_000, 4_990_000, 5_010_000, 4_980_000, 5_000_000)],
    });
    const placed = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", side: "buy", type: "market" },
    });
    const placedBody = placed.json() as Envelope<OrderBody>;
    expect(placedBody.data.status).toBe("FULLY_FILLED");
    expect(placedBody.data.price).toBeUndefined();

    const res = await fastify.inject({
      method: "GET",
      url: `/v1/user/spot/order?pair=btc_jpy&order_id=${placedBody.data.order_id}`,
    });
    const body = res.json() as Envelope<OrderBody>;
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("FULLY_FILLED");
    expect(body.data.price).toBeUndefined();
    expect(body.data.post_only).toBeUndefined();
    expect(body.data.average_price).toBe("5000000");
    expect(body.data.ordered_at).toBe(placedBody.data.ordered_at);
  });

  it("formats 0.1+0.2 amounts to pair digits", async () => {
    const amount = String(0.1 + 0.2);
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000 } }));
    const placed = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount, price: "1000000", side: "buy", type: "limit" },
    });
    const placedBody = placed.json() as Envelope<OrderBody>;
    expect(placed.statusCode).toBe(200);
    const res = await fastify.inject({
      method: "GET",
      url: `/v1/user/spot/order?pair=btc_jpy&order_id=${placedBody.data.order_id}`,
    });
    const body = res.json() as Envelope<OrderBody>;
    expect(body.data.start_amount).toMatch(/^\d+\.\d{4}$/);
    expect(body.data.remaining_amount).toBe("0.3000");
    expect(body.data.executed_amount).toBe("0.0000");
  });

  it("returns 50009 for an unknown id", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=btc_jpy&order_id=999",
    });
    const body = res.json() as Envelope<{ code: number }>;
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(50009);
  });

  it("returns 50009 when pair does not match", async () => {
    const { fastify } = await build(
      buildState({ orders: [buildOrder({ id: "1", pair: "btc_jpy" })] }),
    );
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=eth_jpy&order_id=1",
    });
    const body = res.json() as Envelope<{ code: number }>;
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(50009);
  });

  it("returns 30006 when order_id is missing", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=btc_jpy",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Envelope<{ code: number }>;
    expect(body.data.code).toBe(30006);
  });
});

describe("POST /v1/user/spot/orders_info", () => {
  const build = setupBuildTestServer();

  it("returns found orders and omits missing ids", async () => {
    const { fastify } = await build(
      buildState({
        orders: [buildOrder({ id: "1" }), buildOrder({ id: "2", price: 5_100_000 })],
      }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/orders_info",
      payload: { pair: "btc_jpy", order_ids: [2, 999, 1] },
    });
    const body = res.json() as Envelope<{ orders: OrderBody[] }>;
    expect(body.success).toBe(1);
    expect(body.data.orders.map((o) => o.order_id)).toEqual([2, 1]);
  });

  it("returns the same snapshot on two consecutive calls after a fill", async () => {
    const now = Date.now();
    const orderedAt = new Date(now - 120_000).toISOString();
    const { fastify } = await build(
      buildState({
        balances: { jpy: 10_000_000 },
        lastTickAt: orderedAt,
        orders: [buildOrder({ id: "1", orderedAt, price: 5_000_000 })],
      }),
      { btc_jpy: [candle(now - 60_000, 4_990_000, 5_010_000, 4_980_000, 5_000_000)] },
    );
    const first = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/orders_info",
      payload: { pair: "btc_jpy", order_ids: [1] },
    });
    const second = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/orders_info",
      payload: { pair: "btc_jpy", order_ids: [1] },
    });
    expect(first.json()).toEqual(second.json());
    const body = first.json() as Envelope<{ orders: OrderBody[] }>;
    expect(body.data.orders[0]?.status).toBe("FULLY_FILLED");
    const snap = body.data.orders[0]!;
    expect(Number(snap.executed_amount) * Number(snap.average_price)).toBe(5000);
  });

  it("succeeds with an empty result when no ids match", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/orders_info",
      payload: { pair: "btc_jpy", order_ids: [1, 2] },
    });
    const body = res.json() as Envelope<{ orders: unknown[] }>;
    expect(body.success).toBe(1);
    expect(body.data.orders).toEqual([]);
  });
});

describe("average_price rounding", () => {
  it("keeps the product within half a price unit on partial fills", () => {
    let state = buildState({
      balances: { jpy: 10_000_000, btc: 0 },
      orders: [
        buildOrder({
          id: "1",
          startAmount: 1,
          executedAmount: 0,
          executedNotional: 0,
          price: 101,
        }),
      ],
    });
    const first = fillOrder(state, "1", 100, 0.5, "2026-01-01T00:01:00.000Z");
    expect(first.success).toBe(true);
    if (!first.success) return;
    const second = fillOrder(first.data.state, "1", 101, 0.5, "2026-01-01T00:02:00.000Z");
    expect(second.success).toBe(true);
    if (!second.success) return;
    const order = second.data.order;
    const avg = Number(formatAveragePrice(order));
    const product = Number(formatOrder(order).executed_amount) * avg;
    const slack = order.executedAmount * priceUnit(order.pair) * 0.5;
    expect(Math.abs(product - order.executedNotional)).toBeLessThanOrEqual(slack);
  });

  it("does not divide when executed amount is 0", () => {
    expect(formatAveragePrice(buildOrder())).toBe("0");
  });
});
