import { describe, expect, it } from "vitest";
import { formatAveragePrice, formatOrder } from "../../src/routes/format.ts";
import { priceUnit } from "../../src/engine/precision.ts";
import { fillOrder } from "../../src/engine/transitions.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";
import {
  IMPLEMENTED_ORDER_TYPES,
  OFFICIAL_FETCH_ORDER_STATUSES,
  UNIMPLEMENTED_ORDER_FIELDS,
  orderShape,
} from "./official-fields.ts";

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

describe("official field set", () => {
  const build = setupBuildTestServer();

  it("GET /v1/user/spot/order returns exactly the fields the official order response defines", async () => {
    // 未約定の指値: price と post_only が出る条件（type = limit）を満たす。
    const { fastify } = await build(buildState({ orders: [buildOrder({ id: "1" })] }));
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=btc_jpy&order_id=1",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Envelope<Record<string, unknown>>;
    const s = orderShape(body.data, { type: "limit", canceled: false });
    expect(s.actual).toEqual(s.expected);
    expect(OFFICIAL_FETCH_ORDER_STATUSES).toContain(body.data.status);
    expect(IMPLEMENTED_ORDER_TYPES).toContain(body.data.type);
    for (const f of UNIMPLEMENTED_ORDER_FIELDS) expect(body.data).not.toHaveProperty(f);
  });

  it("GET /v1/user/spot/order omits price and post_only for a market order", async () => {
    // 公式の条件は type = limit。成行では両方とも出ない。
    const now = Date.now();
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000 } }), {
      btc_jpy: [candle(now - 60_000, 4_990_000, 5_010_000, 4_980_000, 5_000_000)],
    });
    const placed = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", side: "buy", type: "market" },
    });
    const placedBody = placed.json() as Envelope<Record<string, unknown>>;
    const res = await fastify.inject({
      method: "GET",
      url: `/v1/user/spot/order?pair=btc_jpy&order_id=${placedBody.data.order_id}`,
    });
    const body = res.json() as Envelope<Record<string, unknown>>;
    const s = orderShape(body.data, { type: "market", canceled: false });
    expect(s.actual).toEqual(s.expected);
  });

  it("GET /v1/user/spot/order adds canceled_at only for a canceled order", async () => {
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
    const body = res.json() as Envelope<Record<string, unknown>>;
    const s = orderShape(body.data, { type: "limit", canceled: true });
    expect(s.actual).toEqual(s.expected);
  });

  it("POST /v1/user/spot/orders_info wraps the same objects under `orders`", async () => {
    const { fastify } = await build(
      buildState({
        orders: [
          buildOrder({ id: "1" }),
          buildOrder({
            id: "2",
            status: "CANCELED_UNFILLED",
            canceledAt: "2026-01-01T00:01:00.000Z",
          }),
        ],
      }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/orders_info",
      payload: { pair: "btc_jpy", order_ids: [1, 2] },
    });
    const body = res.json() as Envelope<Record<string, unknown>>;
    // 公式の応答は data 直下に orders だけを持つ。
    expect(Object.keys(body.data)).toEqual(["orders"]);
    const orders = body.data.orders as Record<string, unknown>[];
    expect(orders).toHaveLength(2);
    const open = orderShape(orders[0]!, { type: "limit", canceled: false });
    expect(open.actual).toEqual(open.expected);
    const canceled = orderShape(orders[1]!, { type: "limit", canceled: true });
    expect(canceled.actual).toEqual(canceled.expected);
  });
});

describe("post_only の出現条件", () => {
  const build = setupBuildTestServer();

  it("keeps post_only for a limit order that has no price", async () => {
    // 公式は price を「type = limit または stop_limit のみ」、post_only を
    // 「type = limit のみ」と別条件で定める。price 欠落は API 経由では作れないが、
    // 永続化した state から復元しうるので、2 つの条件が独立であることを固定する。
    const { fastify } = await build(
      buildState({ orders: [buildOrder({ id: "1", type: "limit", price: null })] }),
    );
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=btc_jpy&order_id=1",
    });
    const body = res.json() as Envelope<Record<string, unknown>>;
    expect(body.data).not.toHaveProperty("price");
    expect(body.data.post_only).toBe(false);
  });
});

// 実 API の実測（2026-09-17、認証済みの口座）で決めたコード。`?pair=` を落とすと
// 30009（"Missing asset."）。不正なペアの 40017 は**この PR では扱わない** —
// 実 API は登録外のペア（`xxx_yyy`）にも 40017 を返すが、それはホワイトリストを
// 持つという意味で、本モックは文字種しか見ない設計を明示的に選んでいる
// （create-order.test.ts の「ホワイトリストにしていないことの証明」）。
// docs/fidelity.md に未確定として記録した。
describe("ペアのコード", () => {
  const build = setupBuildTestServer();

  it("GET order: pair を落とすと 30009", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({ method: "GET", url: "/v1/user/spot/order?order_id=1" });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(30009);
  });

  it("orders_info: pair を落とすと 30009", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/orders_info",
      payload: { order_ids: [1] },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30009);
  });
});
