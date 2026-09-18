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
      expect(res.statusCode, query).toBe(200);
      expect(res.json(), query).toEqual({ success: 0, data: { code } });
    }
  });

  /**
   * 同名のクエリが 2 本来ると値は配列になる。**要素数を数えて先頭を採ったりせず**、
   * 空文字や空白と同じくパラメータ固有のコードで断る（`docs/fidelity.md` の
   * 「同じ名前で複数来る値」行）。**実 API がどう扱うかは未実測**なので、ここで
   * 固定しているのはモックの挙動であって本物との一致ではない。
   *
   * スキーマ側の判定は `tests/schemas/requests.test.ts` が見る。ここで見るのは
   * それが wire 上どの code になるかである。
   */
  it("同名のクエリが 2 本来ても数値へ強制せず、固有のコードで断る", async () => {
    const { fastify } = await build(stateWithTwoOrders());
    const cases: Array<[string, number]> = [
      ["count=1&count=2", 40006],
      ["end=1&end=2", 40007],
      ["end_id=1&end_id=2", 40008],
      ["from_id=1&from_id=2", 40009],
      ["since=1&since=2", 40022],
    ];
    for (const [query, code] of cases) {
      const res = await fastify.inject({
        method: "GET",
        url: `/v1/user/spot/active_orders?${query}`,
      });
      expect(res.statusCode, query).toBe(200);
      expect(res.json(), query).toEqual({ success: 0, data: { code } });
    }
  });

  /**
   * 空白だけの値も空文字と同じ扱いにする。`Number()` は前後の空白を読み飛ばすので
   * `" "` / `"\t"` / `"\n"` / `"\u00a0"` はいずれも `0` になり、空文字と同じ抜け方をする。
   * 旧実装では `?end=%20` が **`success: 1` のまま 0 件**を返していた
   * （`count` だけは `0` が `positive()` に落ちて偶然 `40006` になっていた）。
   */
  it("空白だけの値も空文字と同じコードで断る", async () => {
    const { fastify } = await build(stateWithTwoOrders());
    const cases: Array<[string, number]> = [
      ["end=%20", 40007],
      ["end=%09", 40007],
      ["end=%0a", 40007],
      ["end=%C2%A0", 40007],
      ["since=%20", 40022],
      ["from_id=%20", 40009],
      ["end_id=%20", 40008],
      ["count=%20", 40006],
    ];
    for (const [query, code] of cases) {
      const res = await fastify.inject({
        method: "GET",
        url: `/v1/user/spot/active_orders?${query}`,
      });
      expect(res.statusCode, query).toBe(200);
      expect(res.json(), query).toEqual({ success: 0, data: { code } });
    }
  });

  // 同名クエリが 2 本来ると値は配列になる。要素数を数えずに数値へ強制しない。
  it("同名クエリが 2 本来たら数値へ強制せず断る", async () => {
    const { fastify } = await build(stateWithTwoOrders());
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/active_orders?end=1&end=2",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: 0, data: { code: 40007 } });
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
