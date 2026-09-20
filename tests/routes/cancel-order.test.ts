import { describe, expect, it } from "vitest";
import { activeOrders } from "../../src/engine/state.ts";
import { MAX_CANCEL_ORDER_IDS } from "../../src/routes/cancel-order.ts";
import { buildOrder, buildState, buildTrade } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";
import {
  OFFICIAL_CANCEL_ORDER_STATUSES,
  orderShape,
  UNIMPLEMENTED_ORDER_FIELDS,
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
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30006);
  });
});

/** `1` から `n` までの id。件数の境界を見るテストが使う。 */
function openOrderIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => String(i + 1));
}

/** 与えた id の未約定の指値買いだけを持つ状態。残高は全件の拘束を賄える額にする。 */
function stateWithOpenOrders(ids: string[]) {
  return buildState({
    balances: { jpy: 10_000_000 },
    orders: ids.map((id) => buildOrder({ id })),
  });
}

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

  /**
   * 同じ id を 2 回以上入れたとき、その注文は 1 回だけ取り消され `orders` にも 1 件しか載る。
   *
   * `order_ids` の重複は落とさないので同じ id が並び、2 件目以降は直前の取消で終端になった
   * 注文に当たって `cancelOrder` が `ORDER_NOT_ACTIVE` を返す。ルートはそれを読み飛ばす。
   *
   * 応答の `orders` が `order_ids` より短くなる 3 経路のうちの 1 つ（他の 2 つは存在しない id と
   * 別のペアの id。次のテストで見る）。docs/fidelity.md の「取消済み・約定済みの取消」節が
   * 「取消が一部だけ成立する意味での部分成功は起きない」と書いているのと両立する
   * （同じ注文を 1 回取り消しただけで、取り逃した注文は無い）。
   */
  it("cancels a duplicated id once and returns it once", async () => {
    const state = buildState({
      balances: { jpy: 10_000_000 },
      orders: [buildOrder({ id: "1" }), buildOrder({ id: "2", price: 5_100_000 })],
    });
    const { fastify, store } = await build(state);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "btc_jpy", order_ids: [1, 1] },
    });
    const body = res.json() as { success: number; data: { orders: Array<{ order_id: number }> } };
    expect(body.success).toBe(1);
    // 要求は 2 件だが応答は 1 件。件数の一致で成否を判定できない。
    expect(body.data.orders).toHaveLength(1);
    expect(body.data.orders[0]?.order_id).toBe(1);
    // 巻き込みは起きない（2 は active のまま）。
    expect(activeOrders(store.state()).map((o) => o.id)).toEqual(["2"]);
  });

  /**
   * そのペアの注文に解決しない id は黙って飛ばす。エラーにはせず、解決した分だけ取り消す。
   *
   * 飛ぶのは 2 通り。(a) 存在しない id、(b) 別のペアの注文の id。`working.orders.find` が
   * id と pair の両方で照合するので、どちらも `undefined` になって `continue` へ落ちる。
   *
   * 重複 id と併せて、応答の `orders` が `order_ids` より短くなる経路はこの 3 つである
   * （docs/fidelity.md の「取消済み・約定済みの取消」節）。呼び出し側が件数の一致で成否を
   * 判定できないのはこのため。
   */
  it("skips ids that do not resolve to an order of the requested pair", async () => {
    const state = buildState({
      balances: { jpy: 10_000_000 },
      orders: [buildOrder({ id: "1" }), buildOrder({ id: "2", pair: "eth_jpy", price: 300_000 })],
    });
    const { fastify, store } = await build(state);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      // 999 は存在しない id、2 は別のペア（eth_jpy）の注文。
      payload: { pair: "btc_jpy", order_ids: [1, 999, 2] },
    });
    const body = res.json() as { success: number; data: { orders: Array<{ order_id: number }> } };
    // 3 件要求して 1 件。エラーにはならない。
    expect(body.success).toBe(1);
    expect(body.data.orders).toHaveLength(1);
    expect(body.data.orders[0]?.order_id).toBe(1);
    // 別のペアの注文は active のまま残る。
    expect(activeOrders(store.state()).map((o) => o.id)).toEqual(["2"]);
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
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(20003);
    expect(activeOrders(store.state()).map((o) => o.id)).toEqual(["2"]);
  });

  /**
   * `order_ids` の 30 件上限（`docs/fidelity.md` の「一括取消の件数上限」節）。
   *
   * 上限の値は公式のパラメータ表に明記されている（`rest-api.md:548` "Up to 30 ids can be
   * specified"）。**境界の両側を見る**——30 件ちょうどが通ることを見ないと、「全部断る」
   * 実装でも `40015` のテストだけは通ってしまう。
   *
   * **`orders_info` には同じ上限が無い**（公式に記載が無い）。その非対称は
   * `tests/routes/order-info.test.ts` が 31 件を受け付ける側で固定している。
   */
  it("上限の値は公式のパラメータ表どおり 30 件である", () => {
    expect(MAX_CANCEL_ORDER_IDS).toBe(30);
  });

  it(`cancels exactly ${MAX_CANCEL_ORDER_IDS} ids`, async () => {
    const ids = openOrderIds(MAX_CANCEL_ORDER_IDS + 1);
    const { fastify, store } = await build(stateWithOpenOrders(ids));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "btc_jpy", order_ids: ids.slice(0, MAX_CANCEL_ORDER_IDS) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { orders: unknown[] } };
    expect(body.success).toBe(1);
    expect(body.data.orders).toHaveLength(MAX_CANCEL_ORDER_IDS);
    // 上限ちょうどは素通しなので、残るのは超過分の 1 件だけ。
    expect(activeOrders(store.state()).map((o) => o.id)).toEqual([
      ids[MAX_CANCEL_ORDER_IDS] as string,
    ]);
  });

  it(`returns 40015 for ${MAX_CANCEL_ORDER_IDS + 1} ids and changes no state`, async () => {
    const ids = openOrderIds(MAX_CANCEL_ORDER_IDS + 1);
    const { fastify, store } = await build(stateWithOpenOrders(ids));
    // 「1 件も取り消さない」だけでなく「状態が一切変わらない」ことを見る。
    // 件数の検査は `store.tick()` より前にあるので、約定も進まない。
    const before = structuredClone(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "btc_jpy", order_ids: ids },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(40015);
    expect(store.state()).toEqual(before);
    expect(activeOrders(store.state())).toHaveLength(ids.length);
  });
});

/**
 * **発注停止のペアでも既存注文の取消は通る**（`docs/fidelity.md` の「ペア」節）。
 *
 * 新規発注は `70017` で断るようになったが（`tests/routes/create-order.test.ts` の
 * 「発注停止のペア」）、取消はその対象ではない。根拠は固定コミットの公式ドキュメントに
 * ある——`rest-api.md:1696-1697` が `stop_order`（"order suspended flag"）と
 * `stop_order_and_cancel`（"order **and cancel** suspended flag"）を**書き分けている**ので、
 * 前者だけが立っている状態から取消の禁止は読めない。**静的なペア表が持つのは
 * `orderSuspended`（= `stop_order` に対応する列）だけで、`stop_order_and_cancel` の値は
 * 持っていない。**
 *
 * 取り除く手段を塞がないという既存の判断とも噛み合う（取消経路はそもそも公式一覧を
 * 見ない。`tests/routes/pair-whitelist.test.ts` の `COVERED_ELSEWHERE`）。
 */
describe("発注停止のペアの取消", () => {
  const build = setupBuildTestServer();

  /** 停止ペア（`_btc` の 15 ペアのうちの 1 つ）の未約定の指値。 */
  const suspendedPairState = () =>
    buildState({
      balances: { jpy: 1_000_000, btc: 100 },
      orders: [
        buildOrder({ id: "1", pair: "xrp_btc", side: "buy", price: 1, startAmount: 1 }),
        buildOrder({ id: "2", pair: "xrp_btc", side: "buy", price: 1, startAmount: 1 }),
      ],
    });

  it("cancel_order は停止ペアの注文を取り消せる", async () => {
    const { fastify, store } = await build(suspendedPairState());
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "xrp_btc", order_id: 1 },
    });
    const body = res.json() as { success: number; data: { status: string } };
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("CANCELED_UNFILLED");
    expect(activeOrders(store.state()).map((o) => o.id)).toEqual(["2"]);
  });

  it("cancel_orders も停止ペアの注文を取り消せる", async () => {
    const { fastify, store } = await build(suspendedPairState());
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "xrp_btc", order_ids: [1, 2] },
    });
    const body = res.json() as { success: number; data: { orders: unknown[] } };
    expect(body.success).toBe(1);
    expect(body.data.orders).toHaveLength(2);
    expect(activeOrders(store.state())).toHaveLength(0);
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
