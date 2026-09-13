import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { activeOrders } from "../../src/engine/state.ts";
import { controlRoutes, controlTokenHeader } from "../../src/routes/control.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildOrder, buildState } from "../engine/helpers.ts";

/** src/routes/control.ts の `MAX_CLOCK_AHEAD_MS` と同じ値（実装は export していない）。 */
const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;

async function buildControl(
  state = buildState({
    balances: { jpy: 10_000_000 },
    orders: [buildOrder({ id: "1", price: 5_000_000, startAmount: 0.001 })],
  }),
  opts: { token?: string; controlEnabled?: boolean } = {},
) {
  const store = new SessionStore(state, { path: null, fillMode: "manual" });
  const fastify = await buildServer({
    store,
    logger: false,
    controlEnabled: opts.controlEnabled ?? true,
    controlToken: opts.token,
  });
  return { fastify, store };
}

describe("GET/POST /_control without BITBANK_MOCK_CONTROL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("returns 404 when control is disabled", async () => {
    const { fastify } = await buildControl(buildState(), { controlEnabled: false });
    cleanups.push(async () => {
      await fastify.close();
    });
    const res = await fastify.inject({ method: "GET", url: "/_control/state" });
    expect(res.statusCode).toBe(404);
  });
});

describe("/_control routes", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  async function setup(state?: Parameters<typeof buildControl>[0], opts?: Parameters<typeof buildControl>[1]) {
    const r = await buildControl(state, opts);
    cleanups.push(async () => {
      await r.fastify.close();
    });
    return r;
  }

  it("returns state on loopback", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({ method: "GET", url: "/_control/state" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(store.state());
  });

  it("forbids non-loopback when no token is configured", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({
      method: "GET",
      url: "/_control/state",
      remoteAddress: "10.0.0.8",
    });
    expect(res.statusCode).toBe(403);
  });

  it("forbids non-loopback without a token", async () => {
    const { fastify } = await setup(undefined, { token: "secret" });
    const res = await fastify.inject({
      method: "GET",
      url: "/_control/state",
      remoteAddress: "10.0.0.8",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "FORBIDDEN" });
  });

  it("allows non-loopback with the matching token", async () => {
    const { fastify } = await setup(undefined, { token: "secret" });
    const res = await fastify.inject({
      method: "GET",
      url: "/_control/state",
      remoteAddress: "10.0.0.8",
      headers: { "x-control-token": "secret" },
    });
    expect(res.statusCode).toBe(200);
  });

  // 誤ったトークンは、違う位置・違う長さのどちらでも同じ 403 になる。
  it.each([["secreT"], ["Secret"], ["s"], ["secret "], ["secretsecret"]])(
    "forbids non-loopback with a wrong token: %s",
    async (token) => {
      const { fastify } = await setup(undefined, { token: "secret" });
      const res = await fastify.inject({
        method: "GET",
        url: "/_control/state",
        remoteAddress: "10.0.0.8",
        headers: { "x-control-token": token },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "FORBIDDEN" });
    },
  );

  // 同名ヘッダが 2 行来ると Node は request.headers 側で ", " 繋ぎの 1 本にするので、
  // 繋いだ結果が設定値と一致し得る。行数は生ヘッダで数えて 1 本のときだけ受ける。
  it("takes the token only when exactly one header line carries it", () => {
    /** 生ヘッダだけを持つ最小の request を作る（`controlTokenHeader` はそこしか見ない）。 */
    const withRaw = (rawHeaders: string[]) =>
      ({ raw: { rawHeaders } }) as unknown as Parameters<typeof controlTokenHeader>[0];
    expect(controlTokenHeader(withRaw(["Host", "x", "X-Control-Token", "secret"]))).toBe("secret");
    expect(controlTokenHeader(withRaw(["host", "x", "x-control-token", "secret"]))).toBe("secret");
    expect(controlTokenHeader(withRaw(["Host", "x"]))).toBeNull();
    expect(
      controlTokenHeader(withRaw(["X-Control-Token", "part1", "X-Control-Token", "part2"])),
    ).toBeNull();
  });

  // 許可判定はソケットの対向アドレスだけを見る。trustProxy を有効にしたサーバでも
  // X-Forwarded-For でループバックを騙れない（buildServer は trustProxy を設定しないが、
  // 判定が request.ip に依存していると、有効にした瞬間に境界が消える）。
  it("ignores X-Forwarded-For even when the server trusts proxies", async () => {
    const store = new SessionStore(buildState(), { path: null, fillMode: "manual" });
    const fastify = Fastify({ logger: false, trustProxy: true });
    fastify.decorate("store", store);
    await fastify.register(controlRoutes, { prefix: "/_control", token: "secret" });
    cleanups.push(async () => {
      await fastify.close();
    });
    for (const forwarded of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.1, 10.0.0.8"]) {
      const res = await fastify.inject({
        method: "GET",
        url: "/_control/state",
        remoteAddress: "10.0.0.8",
        headers: { "x-forwarded-for": forwarded },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("fills an active order completely", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { order: { status: string; executed_amount: string }; trade: { amount: string } };
    expect(body.order.status).toBe("FULLY_FILLED");
    expect(body.order.executed_amount).toBe("0.0010");
    expect(body.trade.amount).toBe("0.0010");
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  it("partially fills when amount is less than remaining", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { amount: 0.0004 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      order: { status: string; executed_amount: string; remaining_amount: string; average_price: string };
    };
    expect(body.order.status).toBe("PARTIALLY_FILLED");
    expect(body.order.executed_amount).toBe("0.0004");
    expect(body.order.remaining_amount).toBe("0.0006");
    expect(body.order.average_price).toBe("5000000");
  });

  it("returns 404 when the order does not exist", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({ method: "POST", url: "/_control/orders/999/fill", payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "ORDER_NOT_FOUND" });
  });

  it("returns 409 when the order is terminal", async () => {
    const { fastify } = await setup(
      buildState({
        orders: [
          buildOrder({
            id: "1",
            status: "CANCELED_UNFILLED",
            canceledAt: "2026-01-01T00:01:00.000Z",
          }),
        ],
      }),
    );
    const res = await fastify.inject({ method: "POST", url: "/_control/orders/1/fill", payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "ORDER_NOT_ACTIVE", status: "CANCELED_UNFILLED" });
  });

  it("returns 400 when amount exceeds remaining", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { amount: 0.002 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_AMOUNT", remaining: 0.001 });
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  it("returns 400 when amount has extra digits", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { amount: 0.00001 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_AMOUNT", remaining: 0.001 });
    expect(store.state().trades).toHaveLength(0);
  });

  it("returns 400 when a supplied fill price has extra digits", async () => {
    const { fastify, store } = await setup(
      buildState({
        balances: { jpy: 0, btc: 0.001 },
        orders: [buildOrder({ id: "1", side: "sell", price: 5_000_000, startAmount: 0.001 })],
      }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { price: 5_000_000.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_PRICE" });
    expect(store.state().trades).toHaveLength(0);
  });

  it("returns 400 when price is not a finite positive number", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { price: Number.POSITIVE_INFINITY },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_PRICE" });
  });

  it("ticks matching orders from a synthetic price", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", price: 4_900_000 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { filled: unknown[] };
    expect(body.filled).toHaveLength(1);
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  // 互換ルートと同じ pairAssets で弾く。状態ファイル由来の文字種が不正なペアを
  // runTick へ渡すと applyFill が throw して 500 になるので、ここで 400 にする。
  it.each([["../../admin_jpy"], ["btc?a=1_jpy"], ["btc#frag_jpy"], ["btc_jpy_x"], [""]])(
    "rejects a malformed pair without filling: %s",
    async (pair) => {
      const { fastify, store } = await setup();
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/tick",
        payload: { pair, price: 4_900_000 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "INVALID_PAIR" });
      expect(activeOrders(store.state())).toHaveLength(1);
    },
  );

  // 状態ファイルから読んだ不正なペアの注文へ tick しても 500 にはならない。
  it("returns 400 instead of 500 for an order carrying a malformed pair", async () => {
    const { fastify, store } = await setup(
      buildState({
        balances: { jpy: 10_000_000, btc: 1 },
        orders: [
          buildOrder({ id: "1", pair: "../../admin_jpy", side: "sell", price: 5_000_000 }),
        ],
      }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "../../admin_jpy", price: 6_000_000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_PAIR" });
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  it("rejects an invalid candle without filling", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", candle: { open: 1, high: Number.POSITIVE_INFINITY, low: 1, close: 1 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_CANDLE" });
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  it("rejects a candle with non-finite volume", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", candle: { open: 1, high: 1, low: 1, close: 1, vol: "invalid" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_CANDLE" });
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  // Date の表現範囲を超える timestamp は有限でも足として使えない。runTick の
  // new Date(nowMs).toISOString() が RangeError になり 500 を返していた経路。
  it.each([[1e20], [8.64e15], [-1e20]])(
    "rejects a candle timestamp outside the Date range without filling: %s",
    async (timestamp) => {
      const { fastify, store } = await setup();
      const before = JSON.stringify(store.state());
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/tick",
        payload: { pair: "btc_jpy", candle: { open: 1, high: 1, low: 1, close: 1, timestamp } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "INVALID_CANDLE" });
      expect(JSON.stringify(store.state())).toBe(before);
    },
  );

  // ---- control の時計（lastTickAt）が実時間から無制限に離れないこと ----
  //
  // 進む経路は 2 つ（足の timestamp と tick ごとの 60 秒の単調前進）で、上限
  // （MAX_CLOCK_AHEAD_MS = 24 時間）は両方に効く。片方だけではもう片方から進む。

  // (b) 単調前進。1 tick 60 秒なので 1440 回で上限に届く。それを越える回数を回しても
  // 時計は上限の内側に留まり、越える tick は 400 で断られる（状態は変えない）。
  it("keeps lastTickAt within the cap however many times tick repeats", async () => {
    const { fastify, store } = await setup(buildState());
    const ticks = 1600;
    let refused = 0;
    let lastRefusal: unknown = null;
    for (let i = 0; i < ticks; i++) {
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/tick",
        payload: { pair: "btc_jpy", price: 1000 },
      });
      if (res.statusCode !== 200) {
        refused += 1;
        lastRefusal = res.json();
        expect(res.statusCode).toBe(400);
      }
    }
    // 1440 回分は今までどおり通り、残りが断られる。
    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThan(ticks);
    expect(lastRefusal).toMatchObject({ error: "CLOCK_TOO_FAR_AHEAD" });
    const ahead = Date.parse(store.state().lastTickAt) - Date.now();
    expect(ahead).toBeLessThanOrEqual(MAX_CLOCK_AHEAD_MS);
  });

  // 断られた tick は状態を変えない（時計も注文も動かない）。
  it("leaves state untouched when a tick is refused at the cap", async () => {
    const { fastify, store } = await setup(
      buildState({ lastTickAt: new Date(Date.now() + MAX_CLOCK_AHEAD_MS).toISOString() }),
    );
    const before = JSON.stringify(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", price: 1000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "CLOCK_TOO_FAR_AHEAD" });
    expect(JSON.stringify(store.state())).toBe(before);
  });

  // (a) 足の timestamp。Date の表現範囲には収まるが実時間から遠すぎる値は、
  // 上の Date 範囲の検査（INVALID_CANDLE）とは別の CANDLE_TOO_FAR_AHEAD で断る。
  it.each([[4e12], [1e15]])(
    "rejects a candle timestamp too far ahead of real time without touching state: %s",
    async (timestamp) => {
      const { fastify, store } = await setup();
      const before = JSON.stringify(store.state());
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/tick",
        payload: { pair: "btc_jpy", candle: { open: 1, high: 1, low: 1, close: 1, timestamp } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "CANDLE_TOO_FAR_AHEAD" });
      expect(JSON.stringify(store.state())).toBe(before);
    },
  );

  // 上限の内側なら先の足も今までどおり通る（境界の直下）。
  it("still accepts a candle just inside the cap", async () => {
    const { fastify, store } = await setup(buildState());
    const timestamp = Date.now() + MAX_CLOCK_AHEAD_MS - 60_000;
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", candle: { open: 1, high: 1, low: 1, close: 1, timestamp } },
    });
    expect(res.statusCode).toBe(200);
    expect(Date.parse(store.state().lastTickAt)).toBe(timestamp);
  });

  // 過去の足を流し直す用途は塞がない。上限は先の側だけに効く。
  it("still accepts a past timestamp and fills from it", async () => {
    const { fastify, store } = await setup();
    const timestamp = Date.now() - 60 * 60 * 1000;
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: {
        pair: "btc_jpy",
        candle: { open: 4_900_000, high: 4_900_000, low: 4_900_000, close: 4_900_000, timestamp },
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { filled: unknown[] }).filled).toHaveLength(1);
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  // (b) の意図: 足は 1 分足なので、同じ実時刻に 2 本注入されても別の窓に落ちなければ
  // ならない。上限を入れても、上限に当たらない限りこの 60 秒の前進は変わらない。
  it("keeps two candles injected at the same wall clock in separate windows", async () => {
    const { fastify, store } = await setup(
      buildState({
        balances: { jpy: 10_000_000 },
        orders: [
          buildOrder({ id: "1", price: 5_000_000, startAmount: 0.001 }),
          buildOrder({ id: "2", price: 4_000_000, startAmount: 0.001 }),
        ],
      }),
    );
    const tick = (price: number) =>
      fastify.inject({ method: "POST", url: "/_control/tick", payload: { pair: "btc_jpy", price } });
    // 1 本目は注文 1 だけ、2 本目は注文 2 だけに当たる価格を選ぶ。
    const first = (await tick(4_500_000)).json() as { filled: unknown[]; lastTickAt: string };
    const second = (await tick(3_500_000)).json() as { filled: unknown[]; lastTickAt: string };
    expect(first.filled).toHaveLength(1);
    expect(second.filled).toHaveLength(1);
    // 2 本目の窓は 1 本目より必ず 60 秒以上先にある（同じ窓には落ちない）。
    expect(Date.parse(second.lastTickAt) - Date.parse(first.lastTickAt)).toBeGreaterThanOrEqual(60_000);
    const [t1, t2] = store.state().trades;
    expect(Date.parse(t2!.executedAt) - Date.parse(t1!.executedAt)).toBeGreaterThanOrEqual(60_000);
  });

  // ---- POST /_control/clock: 時計だけを戻す口 ----

  // 上限に当たった後の復旧。reset と違って注文・約定・残高は残る。
  it("rewinds the clock without dropping orders, trades or balances", async () => {
    const { fastify, store } = await setup(
      buildState({
        lastTickAt: new Date(Date.now() + MAX_CLOCK_AHEAD_MS).toISOString(),
        balances: { jpy: 9_000_000, btc: 0.5 },
        orders: [buildOrder({ id: "1", price: 5_000_000, startAmount: 0.001 })],
      }),
    );
    const res = await fastify.inject({ method: "POST", url: "/_control/clock" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { lastTickAt: string; previousLastTickAt: string };
    expect(Math.abs(Date.parse(body.lastTickAt) - Date.now())).toBeLessThan(60_000);
    expect(body.previousLastTickAt).not.toBe(body.lastTickAt);
    expect(store.state().balances).toEqual({ jpy: 9_000_000, btc: 0.5 });
    expect(activeOrders(store.state())).toHaveLength(1);
    // 戻した後は tick が通る。
    const after = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", price: 1000 },
    });
    expect(after.statusCode).toBe(200);
  });

  it.each([
    ["2026-01-01T00:00:00.000Z" as unknown, Date.parse("2026-01-01T00:00:00.000Z")],
    [Date.parse("2026-01-01T00:00:00.000Z") as unknown, Date.parse("2026-01-01T00:00:00.000Z")],
  ])("accepts an ISO string or epoch ms for lastTickAt: %s", async (lastTickAt, expected) => {
    const { fastify, store } = await setup(buildState());
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/clock",
      payload: { lastTickAt },
    });
    expect(res.statusCode).toBe(200);
    expect(Date.parse(store.state().lastTickAt)).toBe(expected);
  });

  // 時計を戻す口も、時計を上限より先へは動かせない。
  it("refuses to set the clock past the cap and leaves state untouched", async () => {
    const { fastify, store } = await setup(buildState());
    const before = JSON.stringify(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/clock",
      payload: { lastTickAt: Date.now() + MAX_CLOCK_AHEAD_MS + 60_000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "CLOCK_TOO_FAR_AHEAD" });
    expect(JSON.stringify(store.state())).toBe(before);
  });

  it.each([["not a date"], [Number.NaN], [1e20], [{ ms: 1 }], [null]])(
    "rejects a malformed lastTickAt without touching state: %s",
    async (lastTickAt) => {
      const { fastify, store } = await setup(buildState());
      const before = JSON.stringify(store.state());
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/clock",
        payload: { lastTickAt },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "INVALID_CLOCK" });
      expect(JSON.stringify(store.state())).toBe(before);
    },
  );

  // 時計を戻す口は /_control/ の中に閉じる。非ループバックからの境界は他の口と同じで、
  // control 無効時はルート自体が登録されない（= 互換ルートの仕様に混ざらない）。
  it("keeps the clock route inside the /_control boundary", async () => {
    const { fastify } = await setup(undefined, { token: "secret" });
    const forbidden = await fastify.inject({
      method: "POST",
      url: "/_control/clock",
      remoteAddress: "10.0.0.8",
    });
    expect(forbidden.statusCode).toBe(403);
    const { fastify: disabled } = await setup(buildState(), { controlEnabled: false });
    const notFound = await disabled.inject({ method: "POST", url: "/_control/clock" });
    expect(notFound.statusCode).toBe(404);
  });

  // 資産キーは互換ルートが作るペアのセグメントと同じ文字種だけ通す。通してしまうと
  // GET /v1/user/assets の asset にそのまま現れ、状態ファイルにも残る。
  it.each([['{"balances":{"":1}}'], ['{"balances":{"BTC":1}}'], ['{"balances":{"btc jpy":1}}'],
    ['{"balances":{"btc\\n2026-01-01 INFO injected":1}}'], ['{"balances":{"../../etc/passwd":1}}']])(
    "rejects a malformed asset key without touching state: %s",
    async (payload) => {
      const { fastify, store } = await setup();
      const before = JSON.stringify(store.state());
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/reset",
        headers: { "content-type": "application/json" },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "INVALID_BALANCES" });
      expect(JSON.stringify(store.state())).toBe(before);
    },
  );

  // __proto__ はルートへ届く前に Fastify の JSON パーサが本文ごと弾く。
  it("rejects a body carrying a __proto__ key before the route sees it", async () => {
    const { fastify, store } = await setup();
    const before = JSON.stringify(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/reset",
      headers: { "content-type": "application/json" },
      payload: '{"balances":{"__proto__":1}}',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(store.state())).toBe(before);
    expect(Object.getPrototypeOf(store.state().balances)).toBe(Object.prototype);
  });

  it("resets state", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/reset",
      payload: { initialJpy: 50_000, balances: { jpy: 50_000, btc: 1 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { orders: unknown[]; balances: { jpy: number; btc: number }; initialJpy: number };
    expect(body.orders).toEqual([]);
    expect(body.balances).toEqual({ jpy: 50_000, btc: 1 });
    expect(body.initialJpy).toBe(50_000);
  });
});
