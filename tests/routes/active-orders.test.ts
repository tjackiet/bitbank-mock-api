import { describe, expect, it } from "vitest";
import { buildOrder, buildState } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";
import {
  OFFICIAL_FETCH_ORDER_STATUSES,
  UNIMPLEMENTED_ORDER_FIELDS,
  orderShape,
} from "./official-fields.ts";

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

describe("GET /v1/user/spot/active_orders official field set", () => {
  const build = setupBuildTestServer();

  it("returns objects identical in shape to the official order response", async () => {
    // 公式は「Fetch order information のレスポンスオブジェクトのリスト」と定義する。
    // active_orders 専用の形は存在しないので、注文照会と同じ集合で固定する。
    const { fastify } = await build(
      buildState({ orders: [buildOrder({ id: "1" })] }),
    );
    const res = await fastify.inject({ method: "GET", url: "/v1/user/spot/active_orders" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    // 公式の応答は data 直下に orders だけを持つ。
    expect(Object.keys(body.data)).toEqual(["orders"]);
    const orders = body.data.orders as Record<string, unknown>[];
    expect(orders).toHaveLength(1);
    const s = orderShape(orders[0]!, { type: "limit", canceled: false });
    expect(s.actual).toEqual(s.expected);
    expect(OFFICIAL_FETCH_ORDER_STATUSES).toContain(orders[0]!.status);
    for (const f of UNIMPLEMENTED_ORDER_FIELDS) expect(orders[0]!).not.toHaveProperty(f);
    // アクティブな注文は取消済みではないので canceled_at は出ない。
    expect(orders[0]!).not.toHaveProperty("canceled_at");
  });
});

/**
 * 絞り込みパラメータの不正値。実 API を実測して固定した（2026-09-16、`btc_jpy`）。
 *
 * - `?count=` -> 40006 `"Invalid count."`
 * - `?end=`   -> 40007 `"Invalid end param."`
 *
 * 旧実装は `z.coerce.number()` が `""` を `0` にするため、`?end=` が
 * **`success: 1` のまま常に空配列**を返し、`?count=` は汎用の `20003` を返していた。
 */
describe("絞り込みパラメータの不正値（実 API 実測）", () => {
  const build = setupBuildTestServer();

  const stateWithTwoOrders = () =>
    buildState({ orders: [buildOrder({ id: "1" }), buildOrder({ id: "2" })] });

  it("空文字は「未指定」ではなくパラメータ固有のコードで断る", async () => {
    const { fastify } = await build(stateWithTwoOrders());
    const cases: Array<[string, number]> = [
      ["count=", 40006],
      ["end=", 40007],
      ["end_id=", 40008],
      ["from_id=", 40009],
      ["since=", 40022],
    ];
    for (const [query, code] of cases) {
      const res = await fastify.inject({
        method: "GET",
        url: `/v1/user/spot/active_orders?${query}`,
      });
      expect(res.statusCode, query).toBe(400);
      expect(res.json(), query).toEqual({ success: 0, data: { code } });
    }
  });

  it("数値として読めない値も同じコードで断る", async () => {
    const { fastify } = await build(stateWithTwoOrders());
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/active_orders?count=abc",
    });
    expect(res.json()).toEqual({ success: 0, data: { code: 40006 } });
  });

  it("指定が無いときは今までどおり全件を返す", async () => {
    const { fastify } = await build(stateWithTwoOrders());
    const res = await fastify.inject({ method: "GET", url: "/v1/user/spot/active_orders" });
    const body = res.json() as { success: number; data: { orders: unknown[] } };
    expect(body.success).toBe(1);
    expect(body.data.orders).toHaveLength(2);
  });

  it("複数が不正なときは count / from_id / end_id / since / end の順で先に当たったもの", async () => {
    const { fastify } = await build(stateWithTwoOrders());
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/active_orders?end=&count=",
    });
    expect(res.json()).toEqual({ success: 0, data: { code: 40006 } });
  });

  it("絞り込み以外の不正値は従来どおり 20003", async () => {
    const { fastify } = await build(stateWithTwoOrders());
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/active_orders?pair=a&pair=b",
    });
    expect(res.json()).toEqual({ success: 0, data: { code: 20003 } });
  });
});
