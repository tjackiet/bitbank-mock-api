import { describe, expect, it } from "vitest";
import { buildOrder, buildState } from "../engine/helpers.ts";
import { buildTestServer } from "./helpers.ts";

describe("GET /v1/user/assets", () => {
  it("returns assets with locked/free split", async () => {
    const state = buildState({
      balances: { jpy: 1_000_000, btc: 0.5 },
      openOrders: [
        buildOrder({ id: "1", side: "buy", price: 5_000_000, amount: 0.1 }),
      ],
    });
    const { fastify } = await buildTestServer(state);
    const res = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { assets: { asset: string; free_amount: string; locked_amount: string; onhand_amount: string }[] } };
    expect(body.success).toBe(1);
    const jpy = body.data.assets.find((a) => a.asset === "jpy");
    const btc = body.data.assets.find((a) => a.asset === "btc");
    expect(jpy).toBeDefined();
    expect(btc).toBeDefined();
    expect(Number(jpy?.onhand_amount)).toBe(1_000_000);
    expect(Number(jpy?.locked_amount)).toBeGreaterThan(0);
    expect(Number(jpy?.free_amount)).toBeLessThan(1_000_000);
    expect(Number(btc?.onhand_amount)).toBe(0.5);
  });
});
