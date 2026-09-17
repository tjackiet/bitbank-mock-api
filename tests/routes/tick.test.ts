import type { InjectOptions } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { READ_ROUTES, MUTATING_ROUTES } from "../../src/server/degraded.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";

/**
 * 互換ルートが必ず `SessionStore.tick()` を通ることを固定する。
 *
 * `await store.tick()` は 8 つのハンドラの先頭に手で書かれている（`docs/plan-lab-mock.md`
 * 11.2 の決定 11）。フックへ寄せると market モードの `tick()` が内部から `persist()` を
 * 呼ぶ経路と劣化の判定順が絡むので、**移さずにテストで固定する**と決めた。
 * 塞ぎたい失敗は「新しい互換ルートを足した人が `tick()` を書き忘れる」こと。
 *
 * だから**ルートの一覧をここに手書きしない**。手書きにすると、塞ごうとしている
 * 書き忘れがテスト側で起きて、新しいルートが黙って無検査で通る。一覧は
 * `src/server/degraded.ts` の `READ_ROUTES ∪ MUTATING_ROUTES` から導出する。この集合は
 * `assertRouteClassified()` が起動時に網羅を強制しているので、分類漏れたルートは
 * そもそもサーバが起動しない。
 */
const COMPAT_ROUTE_KEYS: string[] = [...READ_ROUTES, ...MUTATING_ROUTES]
  .filter((key) => key.includes(" /v1/user/"))
  .sort();

/**
 * ルートごとの「検証を通る最小の要求」。`tick()` は入力の検証より後・状態の読み出しより
 * 前に呼ばれるので、検証を通らない要求では何も測れない。
 *
 * メソッドと url は鍵から取るので、ここが持つのは本文と query だけ。鍵と食い違う url を
 * 撃つことはできない。**注文が見つかる必要はない**（`tick()` はどのルートでも探索より
 * 前に走る）ので、id は固定で構わない。
 */
const REQUESTS: Record<string, { query?: string; payload?: InjectOptions["payload"] }> = {
  "GET /v1/user/assets": {},
  "GET /v1/user/spot/active_orders": {},
  "GET /v1/user/spot/trade_history": {},
  "GET /v1/user/spot/order": { query: "?pair=btc_jpy&order_id=1" },
  "POST /v1/user/spot/order": {
    payload: { pair: "btc_jpy", side: "buy", type: "limit", price: 4_000_000, amount: 0.001 },
  },
  "POST /v1/user/spot/orders_info": { payload: { pair: "btc_jpy", order_ids: [1] } },
  "POST /v1/user/spot/cancel_order": { payload: { pair: "btc_jpy", order_id: 1 } },
  "POST /v1/user/spot/cancel_orders": { payload: { pair: "btc_jpy", order_ids: [1] } },
};

/** 直前に置いた指値と、それを満たす足。`tick()` が走れば注文 1 が全量約定する。 */
function seeded() {
  const nowMs = Date.now();
  const from = new Date(nowMs - 60_000).toISOString();
  const state = buildState({
    lastTickAt: from,
    orders: [buildOrder({ price: 5_000_000, orderedAt: from, updatedAt: from })],
  });
  // 安値が指値を下回るので買い注文に当たる。24 時間の遡り上限に掛からない位置に置く。
  const candles = { btc_jpy: [candle(nowMs - 30_000, 5_000_000, 5_000_000, 4_900_000, 4_950_000)] };
  return { state, candles };
}

describe("互換ルートは tick を通る", () => {
  const build = setupBuildTestServer();

  it("検査するルートの一覧は degraded.ts の分類から導出する", () => {
    // 導出が空振りしていないこと（空なら it.each が 1 件も回らず、全部が黙って通る）。
    expect(COMPAT_ROUTE_KEYS.length).toBeGreaterThan(0);
    // 片方にだけ足すと落ちる。落ちたら REQUESTS を直す（一覧の側は手で触らない）。
    expect(Object.keys(REQUESTS).sort()).toEqual(COMPAT_ROUTE_KEYS);
  });

  it.each(COMPAT_ROUTE_KEYS)("%s", async (key) => {
    const fixture = REQUESTS[key];
    if (!fixture) {
      throw new Error(
        `${key} の要求が tests/routes/tick.test.ts の REQUESTS にありません。` +
          "検証を通る最小の要求を足してください（ルートを足したら tick も要ります）。",
      );
    }
    const [method, url] = key.split(" ");
    const { state, candles } = seeded();
    const { fastify, store } = await build(state, candles);

    // 呼ばれた順を見る。`tick()` が呼ばれるだけでは足りず、ハンドラが状態を読むより
    // **前**でなければ、そのルートは 1 回古い状態を返す。
    const calls: string[] = [];
    const realTick = store.tick.bind(store);
    const realState = store.state.bind(store);
    vi.spyOn(store, "tick").mockImplementation(async (...args) => {
      calls.push("tick");
      return await realTick(...args);
    });
    vi.spyOn(store, "state").mockImplementation(() => {
      calls.push("state");
      return realState();
    });

    const opts: InjectOptions = {
      method: method as "GET" | "POST",
      url: url + (fixture.query ?? ""),
      payload: fixture.payload,
    };
    const res = await fastify.inject(opts);

    // 検証で弾かれていないこと。弾かれていると tick より手前で返るので、何も測れない。
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toBe("tick");
    expect(calls).toContain("state");
    // 効果まで見る。呼ばれたが約定が state へ入っていない、を通さない。
    expect(realState().orders[0].status).toBe("FULLY_FILLED");
  });
});
