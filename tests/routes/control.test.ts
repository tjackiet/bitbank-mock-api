import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { activeOrders } from "../../src/engine/state.ts";
import { controlRoutes, controlTokenHeader } from "../../src/routes/control.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildOrder, buildState } from "../engine/helpers.ts";

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
