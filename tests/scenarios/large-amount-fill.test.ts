import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invariantViolations } from "../../src/engine/invariants.ts";
import { buildServer } from "../../src/server/http.ts";
import { loadOrInitDefault, SessionStore } from "../../src/store/session.ts";
import { buildState } from "../engine/helpers.ts";

/**
 * 大きい数量の部分約定が作る状態から起動できること。
 *
 * `fillOrder` は残量ちょうどの約定を全約定とみなし `executedAmount` を `startAmount` へ
 * 揃えるので（不変量 3）、trade の `amount` 合計は `startAmount` と最大 1 ulp ずれる。
 * `startAmount` が `8192` を超えるとその 1 ulp が不変量 5 の旧許容差 `1e-12` を上回り、
 * **手で state を編集せず互換ルートと `/_control/` だけで作った状態が読み込み時の検査で
 * 違反と判定され、次の起動が止まっていた**。許容差を大きさへ比例させて決着させた件の回帰テスト。
 */
describe("large-amount partial fill then full fill", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("writes a state file that loads back without invariant violations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bitbank-mock-large-fill-"));
    const path = join(dir, "state.json");
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const store = new SessionStore(buildState({ balances: { jpy: 1_000_000, xrp: 100_000 } }), {
      path,
      fillMode: "manual",
    });
    const fastify = await buildServer({ store, controlEnabled: true });
    cleanups.push(async () => {
      await fastify.close();
    });

    // 1. xrp_jpy の売り指値を 8208.0011 で発注する（桁 4 の格子に載る量）。
    const placed = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "xrp_jpy", side: "sell", type: "limit", amount: "8208.0011", price: "50" },
    });
    expect(placed.statusCode).toBe(200);
    const orderId = (placed.json() as { data: { order_id: number } }).data.order_id;

    // 2. 16.0009 だけ部分約定させる。残量は 8192.000199999999 になる。
    const partial = await fastify.inject({
      method: "POST",
      url: `/_control/orders/${orderId}/fill`,
      payload: { amount: 16.0009 },
    });
    expect(partial.statusCode).toBe(200);

    // 3. 本文 {} で残量を全部約定させる。ここでクランプが効く。
    const rest = await fastify.inject({
      method: "POST",
      url: `/_control/orders/${orderId}/fill`,
      payload: {},
    });
    expect(rest.statusCode).toBe(200);

    const state = store.state();
    const order = state.orders.find((o) => o.id === String(orderId));
    expect(order?.status).toBe("FULLY_FILLED");
    // クランプのずれが実在すること（これが 0 になったらこのテストは境界を踏んでいない）。
    const fills = state.trades.filter((t) => t.orderId === String(orderId));
    const tradeSum = fills.reduce((sum, t) => sum + t.amount, 0);
    expect(tradeSum).not.toBe(order?.executedAmount);
    expect(Math.abs(tradeSum - order!.executedAmount)).toBeGreaterThan(1e-12);
    expect(invariantViolations(state)).toEqual([]);

    // 書き出した state ファイルから起動できること（loadOrInitDefault は違反があれば throw する）。
    await store.persist();
    const reloaded = await loadOrInitDefault(1_000_000, { path, fillMode: "manual" });
    // 自動修復していないこと。読み直した状態は書き出したものと同じ。
    const reloadedOrder = reloaded.state().orders.find((o) => o.id === String(orderId));
    expect(reloadedOrder?.executedAmount).toBe(order?.executedAmount);
    expect(reloaded.state().trades.map((t) => t.amount)).toEqual(fills.map((t) => t.amount));
  });
});
