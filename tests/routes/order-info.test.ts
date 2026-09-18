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
    expect(res.statusCode).toBe(200);
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
// 30009（"Missing asset."）。
//
// **公式一覧に無いペアの 40017 も、いまは扱う。** かつてここには「本モックは文字種しか
// 見ない設計を明示的に選んでいる」と書いていたが、**実 API が `xxx_yyy` に 40017 を
// 返すという実測を受けて覆した**。一覧は `src/engine/pairs.ts` の `OFFICIAL_PAIRS` が
// 持ち、route 層の `isKnownPair()` が見る（`tests/routes/pair-whitelist.test.ts` が
// 4 経路まとめて検査する）。経緯は docs/fidelity.md の「ペア」節。
describe("ペアのコード", () => {
  const build = setupBuildTestServer();

  it("GET order: pair を落とすと 30009", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({ method: "GET", url: "/v1/user/spot/order?order_id=1" });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(30009);
  });

  it("orders_info: order_ids を落とすと 30007", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/orders_info",
      payload: { pair: "btc_jpy" },
    });
    // 失敗でも HTTP は 200（実 API の実測。src/routes/envelope.ts の err の docstring）。
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30007);
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

/**
 * 実 API が「読めない id」と「読めたが存在しない id」を分けていることを固定する。
 *
 * **根拠はすべて 2026-09-17 の実測**（認証済みの口座、読み取り経路のみ）。それまで
 * モックは前者を `50009` / `20003` に潰しており、`docs/fidelity.md` の
 * 「パラメータの型強制」節に未確定として残していた論点である。
 */
describe("不正な id の error code（実測に合わせた）", () => {
  const build = setupBuildTestServer();

  type Env = { success: number; data: { code?: number } };
  /** 封筒を 1 語にたたむ。成功なら `"success:1"`、失敗なら error code。 */
  const verdict = (e: Env) => (e.success === 1 ? "success:1" : e.data.code);

  /** `GET /v1/user/spot/order` を 1 本投げて、success か error code を返す。 */
  const get = async (url: string) => {
    const { fastify } = await build();
    return verdict((await fastify.inject({ method: "GET", url })).json() as Env);
  };

  /** `POST /v1/user/spot/orders_info` を 1 本投げて、success か error code を返す。 */
  const post = async (payload: Record<string, unknown>) => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/orders_info",
      payload,
    });
    return verdict(res.json() as Env);
  };

  it("GET order: 読めない order_id は 40013（50009 ではない）", async () => {
    expect(await get("/v1/user/spot/order?pair=btc_jpy&order_id=true")).toBe(40013);
    expect(await get("/v1/user/spot/order?pair=btc_jpy&order_id=1.5")).toBe(40013);
    // 同名クエリが 2 本来ると値は配列になる。実 API はこれも 40013 を返す。
    expect(await get("/v1/user/spot/order?pair=btc_jpy&order_id=1&order_id=2")).toBe(
      40013,
    );
  });

  it("GET order: 読めたが存在しない order_id は今までどおり 50009", async () => {
    expect(await get("/v1/user/spot/order?pair=btc_jpy&order_id=999999")).toBe(50009);
  });

  it("orders_info: order_ids が id の配列でなければ 40014", async () => {
    expect(await post({ pair: "btc_jpy", order_ids: "1" })).toBe(40014);
    expect(await post({ pair: "btc_jpy", order_ids: 1 })).toBe(40014);
    expect(await post({ pair: "btc_jpy", order_ids: [1.5] })).toBe(40014);
  });

  // 一番大きな差。以前は success: 1 と空の一覧を返しており、注文状態の照合の
  // 主経路で実 API と成否が逆になっていた。
  it("orders_info: 空配列は 40014（success: 1 ではない）", async () => {
    expect(await post({ pair: "btc_jpy", order_ids: [] })).toBe(40014);
  });

  // **実 API は `[true]` に 10001（System error）を返す**（実測）。モックは内部エラーを
  // 模す意味がないので 40014 に寄せる。docs/fidelity.md に差として記録してある。
  it("orders_info: order_ids:[true] は 40014（実 API の 10001 は再現しない）", async () => {
    expect(await post({ pair: "btc_jpy", order_ids: [true] })).toBe(40014);
  });

  it("orders_info: pair が文字列でなくても 40017（20003 ではない）", async () => {
    expect(await post({ pair: true, order_ids: [1] })).toBe(40017);
  });

  // 欠落の 3000x を先に返す順序は実測済み。新しい検査で崩していないことを見る。
  it("欠落は今までどおり 3000x が先に出る", async () => {
    expect(await get("/v1/user/spot/order?pair=btc_jpy")).toBe(30006);
    expect(await get("/v1/user/spot/order?order_id=1")).toBe(30009);
    expect(await post({ pair: "btc_jpy" })).toBe(30007);
    expect(await post({ order_ids: [1] })).toBe(30009);
  });
});
