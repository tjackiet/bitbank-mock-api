import { describe, expect, it } from "vitest";
import { buildState, buildTrade } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";

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
});
