import { describe, expect, it } from "vitest";
import { buildState, buildTrade } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";
import { UNIMPLEMENTED_TRADE_FIELDS, tradeShape } from "./official-fields.ts";

describe("GET /v1/user/spot/trade_history", () => {
  const build = setupBuildTestServer();

  it("returns trades newest-first", async () => {
    const state = buildState({
      trades: [
        buildTrade({
          tradeId: "1",
          orderId: "1",
          side: "buy",
          type: "limit",
          executedAt: "2026-01-01T00:01:00.000Z",
        }),
        buildTrade({
          tradeId: "2",
          orderId: "2",
          side: "sell",
          type: "market",
          price: 5_100_000,
          feeQuote: 6.12,
          makerTaker: "taker",
          executedAt: "2026-01-01T00:02:00.000Z",
        }),
      ],
    });
    const { fastify } = await build(state);
    const res = await fastify.inject({ method: "GET", url: "/v1/user/spot/trade_history" });
    const body = res.json() as {
      success: number;
      data: { trades: { trade_id: number; side: string }[] };
    };
    expect(body.success).toBe(1);
    expect(body.data.trades).toHaveLength(2);
    expect(body.data.trades[0].side).toBe("sell");
    expect(body.data.trades[1].side).toBe("buy");
  });

  it("respects count limit", async () => {
    const state = buildState({
      trades: [
        buildTrade({ tradeId: "1", orderId: "1", executedAt: "2026-01-01T00:01:00.000Z" }),
        buildTrade({
          tradeId: "2",
          orderId: "2",
          side: "sell",
          price: 5_100_000,
          executedAt: "2026-01-01T00:02:00.000Z",
        }),
      ],
    });
    const { fastify } = await build(state);
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/trade_history?count=1",
    });
    const body = res.json() as { data: { trades: unknown[] } };
    expect(body.data.trades).toHaveLength(1);
  });

  it("filters by order_id and respects asc order", async () => {
    const state = buildState({
      trades: [
        buildTrade({ tradeId: "1", orderId: "10", executedAt: "2026-01-01T00:01:00.000Z" }),
        buildTrade({
          tradeId: "2",
          orderId: "10",
          side: "sell",
          price: 5_100_000,
          executedAt: "2026-01-01T00:02:00.000Z",
        }),
        buildTrade({ tradeId: "3", orderId: "11", executedAt: "2026-01-01T00:03:00.000Z" }),
      ],
    });
    const { fastify } = await build(state);
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/trade_history?order_id=10&order=asc",
    });
    const body = res.json() as { data: { trades: { trade_id: number; order_id: number }[] } };
    expect(body.data.trades.map((t) => t.trade_id)).toEqual([1, 2]);
    expect(body.data.trades.every((t) => t.order_id === 10)).toBe(true);
  });

  /**
   * `since` と `end` が**実際に絞り込むこと**を見る。
   *
   * `active_orders` の `end_id` / `end` と同じ穴で、不正値を断る側（下の「空文字は…」）
   * だけが検査されていた。この 2 つの `filter` を no-op に差し替えても 444 件が
   * 1 件も落ちない（実測）。
   *
   * 並びは `order=asc` に固定する。既定の `desc` は上の「returns trades newest-first」が
   * 見ているので、ここでは**どの約定が残るか**だけを読めるようにする。
   */
  it("filters by since and end", async () => {
    const at = (m: number) =>
      new Date(Date.parse("2026-01-01T00:00:00.000Z") + m * 60_000).toISOString();
    const state = buildState({
      trades: [
        buildTrade({ tradeId: "1", orderId: "1", executedAt: at(1) }),
        buildTrade({ tradeId: "2", orderId: "2", price: 5_100_000, executedAt: at(2) }),
        buildTrade({ tradeId: "3", orderId: "3", price: 5_200_000, executedAt: at(3) }),
      ],
    });
    const { fastify } = await build(state);

    // `since` は `executed_at` のミリ秒で、境界を含む（約定 2 が残る）。
    const from = await fastify.inject({
      method: "GET",
      url: `/v1/user/spot/trade_history?order=asc&since=${Date.parse(at(2))}`,
    });
    const fromBody = from.json() as { data: { trades: { trade_id: number }[] } };
    expect(fromBody.data.trades.map((t) => t.trade_id)).toEqual([2, 3]);

    // `end` も境界を含む。
    const to = await fastify.inject({
      method: "GET",
      url: `/v1/user/spot/trade_history?order=asc&end=${Date.parse(at(2))}`,
    });
    const toBody = to.json() as { data: { trades: { trade_id: number }[] } };
    expect(toBody.data.trades.map((t) => t.trade_id)).toEqual([1, 2]);

    // 両端を同じ値で挟むと、境界の 1 件だけが残る。
    const both = await fastify.inject({
      method: "GET",
      url: `/v1/user/spot/trade_history?order=asc&since=${Date.parse(at(2))}&end=${Date.parse(at(2))}`,
    });
    const bothBody = both.json() as { data: { trades: { trade_id: number }[] } };
    expect(bothBody.data.trades.map((t) => t.trade_id)).toEqual([2]);
  });

  /**
   * `count` の上限 1000 を見る。
   *
   * 上限は公式のパラメータ表が持つ（`count | number | NO | take limit (up to 1000)`。
   * `Fetch active orders` の同じ欄は `take limit` だけで上限を書いておらず、モックも
   * `active_orders` には上限を置いていない）。**超過をどう扱うかは公式が書いていない**——
   * モックは断らずに切り詰める側を選んでいる。ここで固定するのはその選択である。
   *
   * 上の「respects count limit」は `count=1` を 2 件に当てるだけで天井に触れないので、
   * `Math.min(q.count, TRADE_HISTORY_MAX)` を `q.count` に差し替えても落ちなかった（実測）。
   */
  it("clamps count at the official 1000 upper bound instead of rejecting", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const state = buildState({
      trades: Array.from({ length: 1001 }, (_, i) =>
        buildTrade({
          tradeId: String(i + 1),
          orderId: String(i + 1),
          executedAt: new Date(base + i * 1000).toISOString(),
        }),
      ),
    });
    const { fastify } = await build(state);
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/trade_history?count=5000",
    });

    // 断らない。上限を超えた count はエラーではなく切り詰めになる。
    const body = res.json() as { success: number; data: { trades: { trade_id: number }[] } };
    expect(body.success).toBe(1);
    expect(body.data.trades).toHaveLength(1000);

    // 既定の desc で新しい順に 1000 件。落ちるのは最も古い 1 件（trade_id 1）。
    expect(body.data.trades[0]?.trade_id).toBe(1001);
    expect(body.data.trades.at(-1)?.trade_id).toBe(2);
  });
});

describe("GET /v1/user/spot/trade_history official field set", () => {
  const build = setupBuildTestServer();

  it("returns exactly the fields the official trade response defines", async () => {
    const { fastify } = await build(
      buildState({ trades: [buildTrade({ tradeId: "1", orderId: "2", feeQuote: 6 })] }),
    );
    const res = await fastify.inject({ method: "GET", url: "/v1/user/spot/trade_history" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    // 公式の応答は data 直下に trades だけを持つ。
    expect(Object.keys(body.data)).toEqual(["trades"]);
    const trades = body.data.trades as Record<string, unknown>[];
    expect(trades).toHaveLength(1);
    const s = tradeShape(trades[0]!);
    expect(s.actual).toEqual(s.expected);
    for (const f of UNIMPLEMENTED_TRADE_FIELDS) expect(trades[0]!).not.toHaveProperty(f);
  });

  it("sets fee_occurred_amount_quote to the same value as fee_amount_quote for spot", async () => {
    // 公式の Description: "In case of spot trading, this value is same as fee_amount_quote."
    const { fastify } = await build(
      buildState({
        trades: [
          buildTrade({ tradeId: "1", orderId: "1", feeQuote: 6 }),
          buildTrade({
            tradeId: "2",
            orderId: "2",
            feeQuote: 12.345,
            executedAt: "2026-01-01T00:02:00.000Z",
          }),
        ],
      }),
    );
    const res = await fastify.inject({ method: "GET", url: "/v1/user/spot/trade_history" });
    const body = res.json() as {
      data: { trades: { fee_amount_quote: string; fee_occurred_amount_quote: string }[] };
    };
    expect(body.data.trades).toHaveLength(2);
    for (const t of body.data.trades) {
      expect(t.fee_occurred_amount_quote).toBe(t.fee_amount_quote);
    }
    // 手数料の桁は jpy の 4 桁。実装とは独立に期待値を書く。
    expect(body.data.trades.map((t) => t.fee_occurred_amount_quote).sort()).toEqual(
      ["12.3450", "6.0000"],
    );
  });
});

/**
 * 絞り込みパラメータの不正値。`trade_history?since=` が 40022
 * `"Invalid trading start time."` を返すことを実 API で実測した（2026-09-16、`btc_jpy`）。
 * 旧実装は `""` を `0` として素通しし、`success: 1` を返していた。
 */
describe("絞り込みパラメータの不正値（実 API 実測）", () => {
  const build = setupBuildTestServer();

  it("空文字はパラメータ固有のコードで断る", async () => {
    const { fastify } = await build(buildState({ trades: [buildTrade({ tradeId: "1" })] }));
    const cases: Array<[string, number]> = [
      ["since=", 40022],
      ["end=", 40007],
      ["count=", 40006],
    ];
    for (const [query, code] of cases) {
      const res = await fastify.inject({
        method: "GET",
        url: `/v1/user/spot/trade_history?${query}`,
      });
      expect(res.statusCode, query).toBe(200);
      expect(res.json(), query).toEqual({ success: 0, data: { code } });
    }
  });

  it("order の不正値は絞り込みの表に無いので従来どおり 20003", async () => {
    const { fastify } = await build(buildState({ trades: [buildTrade({ tradeId: "1" })] }));
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/trade_history?order=sideways",
    });
    expect(res.json()).toEqual({ success: 0, data: { code: 20003 } });
  });
});

/**
 * `trade_history` は `from_id` / `end_id` を持たない。**公式ドキュメントと実 API が
 * 食い違っている論点**で、挙動を決め切れないので公式どおりにしている。
 *
 * - rest-api.md の Fetch trade history のパラメータ表は `pair` / `count` / `order_id` /
 *   `since` / `end` / `order` の 6 つだけ（Fetch active orders の表には両方ある）
 * - ところが実 API は `?end_id=` に `40008`、`?from_id=` に `40009` を返し、**絞り込みにも
 *   使っている**（2026-09-17 実測）
 *
 * 詳細は docs/fidelity.md の「絞り込みパラメータの不正値」節。**この差はモックの
 * 都合ではなく未確定の記録なので、テストで固定して黙って変わらないようにする。**
 */
describe("trade_history は from_id / end_id を持たない（未確定。公式どおり）", () => {
  const build = setupBuildTestServer();

  it.each([["from_id="], ["end_id="], ["from_id=1"], ["end_id=1"]])(
    "%s は無視され success: 1 が返る（active_orders なら断る値）",
    async (query) => {
      const { fastify } = await build(buildState({ trades: [buildTrade({ tradeId: "1" })] }));
      const res = await fastify.inject({
        method: "GET",
        url: `/v1/user/spot/trade_history?pair=btc_jpy&${query}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { success: number; data: { trades: unknown[] } };
      expect(body.success).toBe(1);
      // 絞り込まないので、渡しても件数が変わらない。
      expect(body.data.trades).toHaveLength(1);
    },
  );

  it("対照: active_orders は同じ値を 40009 / 40008 で断る", async () => {
    const { fastify } = await build();
    const from = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/active_orders?pair=btc_jpy&from_id=",
    });
    expect(from.json()).toEqual({ success: 0, data: { code: 40009 } });
    const end = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/active_orders?pair=btc_jpy&end_id=",
    });
    expect(end.json()).toEqual({ success: 0, data: { code: 40008 } });
  });
});
