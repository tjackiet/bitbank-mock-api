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
