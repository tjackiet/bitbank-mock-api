import { describe, expect, it } from "vitest";
import { activeOrders } from "../../src/engine/state.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";
import {
  OFFICIAL_CREATE_ORDER_STATUSES,
  UNIMPLEMENTED_ORDER_FIELDS,
  orderShape,
} from "./official-fields.ts";

describe("POST /v1/user/spot/order", () => {
  const build = setupBuildTestServer();

  it("creates a limit buy and adds to open orders", async () => {
    const { fastify, store } = await build(
      buildState({ balances: { jpy: 10_000_000 } }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { order_id: number; status: string } };
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("UNFILLED");
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  it("rejects limit buy when funds insufficient", async () => {
    const { fastify } = await build(buildState({ balances: { jpy: 100 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(60001);
  });

  // `constructor` を base に持つペアでは availableOf が NaN を返し、`NaN < amount` が
  // false になるため残高ゼロの売りが受理されていた。通常ペアと同じく 60001 で断る。
  it("rejects a sell with no balance even when the base asset shadows Object.prototype", async () => {
    const { fastify, store } = await build(buildState({ balances: { jpy: 1_000_000 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "constructor_jpy", amount: "999", price: "100", side: "sell", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(60001);
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  it("fills market buy at latest candle close", async () => {
    const now = Date.now();
    const { fastify, store } = await build(
      buildState({ balances: { jpy: 10_000_000 } }),
      { btc_jpy: [candle(now - 60_000, 4_990_000, 5_010_000, 4_980_000, 5_000_000)] },
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", side: "buy", type: "market" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: number;
      data: { status: string; price?: string; average_price: string };
    };
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("FULLY_FILLED");
    expect(body.data.price).toBeUndefined();
    expect(Number(body.data.average_price)).toBe(5_000_000);
    expect(store.state().balances.btc).toBe(0.001);
    expect(store.state().trades).toHaveLength(1);
  });

  // pair の欠落は 30009（"Missing asset."）。GET order / orders_info と揃える。
  // この経路も 2026-09-17 に実 API で実測済み（pair が無いと取引できる先が無いので
  // 注文は成立しない）。空白だけの値は下の別テストで 40017 を見る。
  it.each([[undefined], [""]])("returns 30009 when pair is missing: %p", async (pair) => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: {
        ...(pair === undefined ? {} : { pair }),
        amount: "0.001",
        price: "5000000",
        side: "buy",
        type: "limit",
      },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(30009);
  });

  // 空白だけの `pair` は「欠落」ではなく「不正な値」。`isMissing()` が trim しないので
  // `pairAssets()` まで進んで 40017 になる。**実 API も 40017 を返すことを実測した**
  // （2026-09-17）。偶然そうなっていたのではなく一致している、という記録。
  it("returns 40017 when pair is whitespace only", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "   ", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(40017);
  });

  it("rejects invalid pair", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(40017);
  });

  it("does not tick existing orders when the pair is malformed", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const { fastify, store } = await build(
      buildState({
        balances: { jpy: 10_000 },
        lastTickAt: new Date(t0).toISOString(),
        orders: [buildOrder({ id: "1", side: "buy", price: 100, startAmount: 1 })],
      }),
      { btc_jpy: [candle(t0 + 60_000, 110, 110, 50, 105)] },
    );
    const before = structuredClone(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(40017);
    expect(store.state()).toEqual(before);
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  // 記号入りのペアは pairAssets が弾く。既存の分岐（create-order.ts の
  // `if (!pairAssets(pair)) return err(ErrorCode.INVALID_ASSET)`）がそのまま 40017 を返す。
  it.each([["../../admin_jpy"], ["btc?a=1_jpy"], ["btc#frag_jpy"]])(
    "rejects a pair with URL metacharacters: %s",
    async (pair) => {
      const { fastify } = await build();
      const res = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: { pair, amount: "0.001", price: "5000000", side: "buy", type: "limit" },
      });
      const body = res.json() as { success: number; data: { code: number } };
      expect(body.success).toBe(0);
      expect(body.data.code).toBe(40017);
    },
  );

  // 記号入りのペアで発注しても、外向きの足取得が 1 回も起きないこと。
  // market は getLatestPrice を呼ぶ前に弾く必要がある。
  it.each([["../../admin_jpy"], ["btc?a=1_jpy"], ["btc#frag_jpy"]])(
    "never fetches candles for a pair with URL metacharacters: %s",
    async (pair) => {
      const pairs: string[] = [];
      const state = buildState({ balances: { jpy: 10_000_000 } });
      const store = new SessionStore(state, {
        path: null,
        fillMode: "market",
        fetchCandles: async (p) => {
          pairs.push(p);
          return { success: true, data: [] };
        },
      });
      const fastify = await buildServer({ store, logger: false, controlEnabled: false });
      try {
        for (const type of ["limit", "market"] as const) {
          const res = await fastify.inject({
            method: "POST",
            url: "/v1/user/spot/order",
            payload: {
              pair,
              amount: "0.001",
              side: "buy",
              type,
              ...(type === "limit" ? { price: "5000000" } : {}),
            },
          });
          const body = res.json() as { success: number; data: { code: number } };
          expect(body.data.code).toBe(40017);
        }
        expect(pairs).toEqual([]);
      } finally {
        await fastify.close();
      }
    },
  );

  // ホワイトリストにしていないことの証明。公式一覧に無い形の正しいペアは通す。
  it("accepts a well-formed pair that is not in the official pair list", async () => {
    const { fastify, store } = await build(buildState({ balances: { jpy: 10_000_000 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "foo_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { pair: string; order_id: number } };
    expect(body.success).toBe(1);
    expect(body.data.pair).toBe("foo_jpy");
    expect(activeOrders(store.state()).map((o) => o.pair)).toEqual(["foo_jpy"]);
  });

  it("rejects a malformed pair on market before looking up a price", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc", amount: "0.001", side: "buy", type: "market" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(40017);
  });

  it("rejects bad payload", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "-1", side: "buy", type: "limit", price: "5000000" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(20003);
  });

  it("returns 30001 when amount is missing", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", price: "5000000", side: "buy", type: "limit" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30001);
  });

  it("returns 30013 when side is missing", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", type: "limit" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30013);
  });

  it("returns 30015 when type is missing", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30015);
  });

  it("returns 30012 when limit price is missing", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", side: "buy", type: "limit" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30012);
  });

  it("returns 60004 when amount exceeds pair digits", async () => {
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.00001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(60004);
  });
});

describe("POST /v1/user/spot/order official field set", () => {
  const build = setupBuildTestServer();

  it("returns exactly the fields the official create-order response defines (limit)", async () => {
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    const s = orderShape(body.data, { type: "limit", canceled: false });
    expect(s.actual).toEqual(s.expected);
    expect(OFFICIAL_CREATE_ORDER_STATUSES).toContain(body.data.status);
    for (const f of UNIMPLEMENTED_ORDER_FIELDS) expect(body.data).not.toHaveProperty(f);
  });

  it("returns exactly the fields the official create-order response defines (market)", async () => {
    const now = Date.now();
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000 } }), {
      btc_jpy: [candle(now - 60_000, 4_990_000, 5_010_000, 4_980_000, 5_000_000)],
    });
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", side: "buy", type: "market" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    const s = orderShape(body.data, { type: "market", canceled: false });
    expect(s.actual).toEqual(s.expected);
    expect(OFFICIAL_CREATE_ORDER_STATUSES).toContain(body.data.status);
    for (const f of UNIMPLEMENTED_ORDER_FIELDS) expect(body.data).not.toHaveProperty(f);
  });
});
