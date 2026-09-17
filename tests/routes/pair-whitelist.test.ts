import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as requestSchemas from "../../src/schemas/requests.ts";
import { buildOrder, buildState } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";

type Envelope = { success: number; data: { code?: number; orders?: unknown[]; trades?: unknown[] } };

/**
 * 公式一覧に無いペアを断る経路をまとめて見る。
 *
 * **根拠**: 実 API は `pair=xxx_yyy` に `40017`（"Invalid asset."）を返す。照会系 4 経路
 * すべてで実測した（`docs/fidelity.md` の「ペア」節）。ここで見るのはその 4 経路である。
 * 発注（`POST /v1/user/spot/order`）は実弾になるので実 API では測れず、**外挿**で同じ
 * 40017 にしている。そちらの根拠と留保は `tests/routes/create-order.test.ts` にある。
 */
const build = setupBuildTestServer();

/** 一覧に無い形の正しいペア。実 API に投げて 40017 を観測したのがこの値である。 */
const UNKNOWN_PAIR = "xxx_yyy";

const CASES = [
  {
    name: "GET /v1/user/spot/order",
    schema: "GetOrderQuerySchema",
    inject: (pair: string) => ({
      method: "GET" as const,
      url: `/v1/user/spot/order?order_id=1&pair=${pair}`,
    }),
  },
  {
    name: "POST /v1/user/spot/orders_info",
    schema: "OrdersInfoRequestSchema",
    inject: (pair: string) => ({
      method: "POST" as const,
      url: "/v1/user/spot/orders_info",
      payload: { pair, order_ids: [1] },
    }),
  },
  {
    name: "GET /v1/user/spot/active_orders",
    schema: "ActiveOrdersQuerySchema",
    inject: (pair: string) => ({
      method: "GET" as const,
      url: `/v1/user/spot/active_orders?pair=${pair}`,
    }),
  },
  {
    name: "GET /v1/user/spot/trade_history",
    schema: "TradeHistoryQuerySchema",
    inject: (pair: string) => ({
      method: "GET" as const,
      url: `/v1/user/spot/trade_history?pair=${pair}`,
    }),
  },
];

/**
 * ここで見ない、`pair` を取るスキーマとその理由。
 *
 * この集合と上の `CASES` を足したものが「`pair` を取るスキーマ全部」と一致することを
 * 下のテストが見る。**一覧を手で書き写すのではなく `requests.ts` から拾う**ので、
 * 新しく `pair` を取るルートが増えたら、どちらかに載せるまでテストが落ちる。
 */
const COVERED_ELSEWHERE: Record<string, string> = {
  // 発注。外挿であることを明示したいので create-order.test.ts に置いている。
  CreateOrderRequestSchema: "tests/routes/create-order.test.ts",
  // 取消は**意図して一覧を見ない**。この規則より前に書かれた状態ファイルには一覧に
  // 無いペアの注文が残り得るので、取り除く手段を塞がない（`docs/fidelity.md` の
  // 「状態ファイル由来の不正なペア」）。実 API での挙動も実測していない。
  CancelOrderRequestSchema: "意図的に非対象（状態ファイル由来の注文を取り消せるようにする）",
  CancelOrdersRequestSchema: "意図的に非対象（同上）",
};

describe("公式一覧に無いペアの扱い", () => {
  it("pair を取るスキーマはすべて、ここか別のテストで面倒を見ている", () => {
    const withPair = Object.entries(requestSchemas)
      .filter(([, s]) => s instanceof z.ZodObject && "pair" in s.shape)
      .map(([name]) => name)
      .sort();
    const handled = [...CASES.map((c) => c.schema), ...Object.keys(COVERED_ELSEWHERE)].sort();
    expect(withPair).toEqual(handled);
  });

  for (const c of CASES) {
    it(`${c.name} は一覧に無いペアを 40017 で断る`, async () => {
      const { fastify } = await build();
      const res = await fastify.inject(c.inject(UNKNOWN_PAIR));
      const body = res.json() as Envelope;
      expect(body.success).toBe(0);
      expect(body.data.code).toBe(40017);
    });

    // 断る側だけ見ていると「全部断っている」実装でも通ってしまう。
    // 発注停止フラグが立つ `xrp_btc` も照会はできる（一覧にはある）ことを併せて見る。
    it(`${c.name} は一覧にあるペアなら通す（発注停止のペアを含む）`, async () => {
      const state = buildState({
        balances: { jpy: 1_000_000 },
        orders: [buildOrder({ id: "1", pair: "xrp_btc", side: "buy", price: 1, startAmount: 1 })],
      });
      const { fastify } = await build(state);
      const res = await fastify.inject(c.inject("xrp_btc"));
      const body = res.json() as Envelope;
      expect(body.success).toBe(1);
    });
  }
});
