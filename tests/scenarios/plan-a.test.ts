import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildState } from "../engine/helpers.ts";

describe("plan A scenario: place then control fill", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("fills a limit order without fetching market candles", async () => {
    const store = new SessionStore(buildState({ balances: { jpy: 10_000_000 } }), {
      path: null,
      fillMode: "manual",
    });
    const fastify = await buildServer({ store, controlEnabled: true });
    cleanups.push(async () => {
      await fastify.close();
    });

    const placed = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    expect(placed.statusCode).toBe(200);
    const orderId = (placed.json() as { data: { order_id: number } }).data.order_id;

    const before = await fastify.inject({
      method: "GET",
      url: `/v1/user/spot/order?pair=btc_jpy&order_id=${orderId}`,
    });
    const beforeBody = before.json() as {
      data: { status: string; remaining_amount: string; ordered_at: number };
    };
    expect(beforeBody.data.status).toBe("UNFILLED");
    expect(beforeBody.data.remaining_amount).toBe("0.0010");

    const assetsBefore = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    const jpyBefore = (
      assetsBefore.json() as { data: { assets: { asset: string; locked_amount: string; onhand_amount: string }[] } }
    ).data.assets.find((a) => a.asset === "jpy");
    expect(Number(jpyBefore?.locked_amount)).toBeGreaterThan(0);

    const filled = await fastify.inject({
      method: "POST",
      url: `/_control/orders/${orderId}/fill`,
      payload: {},
    });
    expect(filled.statusCode).toBe(200);

    const after = await fastify.inject({
      method: "GET",
      url: `/v1/user/spot/order?pair=btc_jpy&order_id=${orderId}`,
    });
    const afterBody = after.json() as {
      data: {
        status: string;
        executed_amount: string;
        remaining_amount: string;
        average_price: string;
        ordered_at: number;
      };
    };
    expect(afterBody.data.status).toBe("FULLY_FILLED");
    expect(afterBody.data.executed_amount).toBe("0.0010");
    expect(afterBody.data.remaining_amount).toBe("0.0000");
    expect(afterBody.data.average_price).toBe("5000000");
    expect(afterBody.data.ordered_at).toBe(beforeBody.data.ordered_at);

    const assetsAfter = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    const assets = (
      assetsAfter.json() as {
        data: { assets: { asset: string; locked_amount: string; onhand_amount: string }[] };
      }
    ).data.assets;
    const jpyAfter = assets.find((a) => a.asset === "jpy");
    const btcAfter = assets.find((a) => a.asset === "btc");
    expect(Number(jpyAfter?.locked_amount)).toBe(0);
    expect(Number(jpyAfter?.onhand_amount)).toBeLessThan(10_000_000);
    expect(Number(btcAfter?.onhand_amount)).toBe(0.001);
  });
});

/**
 * DCL の委譲枠とモックの拘束額が食い違う境界を固定する。
 *
 * Nyx の DCL は `reserved = price × size`（手数料なし。提案書 6.3）で委譲枠を見るが、
 * モックは `price × amount × (1 + feeRate)` を拘束する（`computeLocked`）。そのため
 * **委譲枠と口座残高が近いとき、DCL が許可した注文をモックが `60001` で断る**
 * （`docs/plan-lab-mock.md` 1.4 節の最終行）。
 *
 * **本物の bitbank が拘束額に手数料を含めるかは公式ドキュメントに無く、実測もしていない。**
 * したがってここは「正しい挙動」ではなく**現状**を固定するテストである。決着したら
 * このテストごと書き換える。何を測れば決着するかは `docs/fidelity.md` の「拘束額」行に書いた。
 */
describe("plan A scenario: DCL の reserved とモックの拘束額の境界", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  const PRICE = 5_000_000;
  const BALANCE = 1_000_000;

  /** 残高を `BALANCE` ちょうどに据えたサーバ。境界の数値はこの残高を前提にしている。 */
  async function build() {
    const store = new SessionStore(buildState({ balances: { jpy: BALANCE } }), {
      path: null,
      fillMode: "manual",
    });
    const fastify = await buildServer({ store, controlEnabled: false });
    cleanups.push(async () => {
      await fastify.close();
    });
    return fastify;
  }

  const place = (fastify: Awaited<ReturnType<typeof build>>, amount: string) =>
    fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount, price: String(PRICE), side: "buy", type: "limit" },
    });

  // price × size がちょうど残高に一致する注文。DCL はこれを枠内として許可する。
  it("DCL が枠内と判定する price × size = 残高 の注文を 60001 で断る", async () => {
    const fastify = await build();
    expect(PRICE * 0.2).toBe(BALANCE);
    const body = (await place(fastify, "0.2")).json() as {
      success: number;
      data: { code: number };
    };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(60001);
  });

  // 手数料ぶんだけ数量を落とすと通る。境界は残高 / (price × (1 + 0.0012))。
  it("手数料ぶん小さい注文は通り、1 単位大きいと断られる", async () => {
    const fastify = await build();
    const ok = (await place(fastify, "0.1997")).json() as { success: number };
    expect(ok.success).toBe(1);

    const fastify2 = await build();
    const ng = (await place(fastify2, "0.1998")).json() as {
      success: number;
      data: { code: number };
    };
    expect(ng.success).toBe(0);
    expect(ng.data.code).toBe(60001);
  });

  // 拘束額そのものにも手数料が乗っている（DCL が assets を読むなら見える差）。
  it("locked_amount が price × amount を手数料ぶん上回る", async () => {
    const fastify = await build();
    expect((await place(fastify, "0.1997")).json()).toMatchObject({ success: 1 });

    const assets = (await fastify.inject({ method: "GET", url: "/v1/user/assets" })).json() as {
      data: { assets: Array<{ asset: string; locked_amount: string }> };
    };
    const jpy = assets.data.assets.find((a) => a.asset === "jpy");
    const notional = PRICE * 0.1997;
    expect(Number(jpy?.locked_amount)).toBeCloseTo(notional * 1.0012, 4);
    expect(Number(jpy?.locked_amount) - notional).toBeCloseTo(notional * 0.0012, 4);
  });
});
