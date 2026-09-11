import { afterEach, describe, expect, it } from "vitest";
import { activeOrders } from "../../src/engine/state.ts";
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
