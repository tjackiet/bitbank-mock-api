import { describe, expect, it } from "vitest";
import { buildState } from "../engine/helpers.ts";
import { buildTestServer } from "./helpers.ts";

describe("GET /v1/user/spot/trade_history", () => {
  it("returns trades newest-first", async () => {
    const state = buildState({
      history: [
        {
          id: "1",
          pair: "btc_jpy",
          side: "buy",
          type: "limit",
          amount: 0.001,
          fillPrice: 5_000_000,
          feeJpy: 6,
          filledAt: "2026-01-01T00:01:00.000Z",
        },
        {
          id: "2",
          pair: "btc_jpy",
          side: "sell",
          type: "market",
          amount: 0.001,
          fillPrice: 5_100_000,
          feeJpy: 6.12,
          filledAt: "2026-01-01T00:02:00.000Z",
        },
      ],
    });
    const { fastify } = await buildTestServer(state);
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
      history: [
        {
          id: "1",
          pair: "btc_jpy",
          side: "buy",
          type: "limit",
          amount: 0.001,
          fillPrice: 5_000_000,
          feeJpy: 6,
          filledAt: "2026-01-01T00:01:00.000Z",
        },
        {
          id: "2",
          pair: "btc_jpy",
          side: "sell",
          type: "limit",
          amount: 0.001,
          fillPrice: 5_100_000,
          feeJpy: 6,
          filledAt: "2026-01-01T00:02:00.000Z",
        },
      ],
    });
    const { fastify } = await buildTestServer(state);
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/trade_history?count=1",
    });
    const body = res.json() as { data: { trades: unknown[] } };
    expect(body.data.trades).toHaveLength(1);
  });
});
