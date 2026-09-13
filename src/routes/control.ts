import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { isValidCandle, type Candle } from "../engine/candles.ts";
import { runTick } from "../engine/match.ts";
import { fitsDigits, precisionOf } from "../engine/precision.ts";
import { isActive, pairAssets, remainingOf } from "../engine/state.ts";
import { fillOrder } from "../engine/transitions.ts";
import { formatOrder, formatTrade } from "./format.ts";
import { asRecord } from "./params.ts";
import { freshState } from "../store/session.ts";

export type ControlRouteOptions = {
  token?: string;
};

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/i, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function clientIp(request: FastifyRequest): string | undefined {
  return request.ip || request.socket.remoteAddress;
}

function syntheticCandle(price: number, timestamp: number): Candle {
  return { open: price, high: price, low: price, close: price, vol: 0, timestamp };
}

export const controlRoutes: FastifyPluginAsync<ControlRouteOptions> = async (fastify, opts) => {
  fastify.addHook("onRequest", async (request, reply) => {
    if (isLoopback(clientIp(request))) return;
    const expected = opts.token;
    const given = request.headers["x-control-token"];
    if (!expected || given !== expected) {
      return reply.code(403).send({ error: "FORBIDDEN" });
    }
  });

  fastify.get("/state", async () => fastify.store.state());

  fastify.post("/reset", async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const current = fastify.store.state();
    let initialJpy = current.initialJpy;
    if (body.initialJpy !== undefined) {
      if (typeof body.initialJpy !== "number" || !Number.isFinite(body.initialJpy) || body.initialJpy < 0) {
        return reply.code(400).send({ error: "INVALID_BALANCES" });
      }
      initialJpy = body.initialJpy;
    }
    let next = freshState(initialJpy);
    if (body.balances !== undefined) {
      if (body.balances === null || typeof body.balances !== "object" || Array.isArray(body.balances)) {
        return reply.code(400).send({ error: "INVALID_BALANCES" });
      }
      const balances: Record<string, number> = {};
      for (const [asset, amount] of Object.entries(body.balances as Record<string, unknown>)) {
        if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
          return reply.code(400).send({ error: "INVALID_BALANCES" });
        }
        balances[asset] = amount;
      }
      next = { ...next, balances };
    }
    fastify.store.replace(next);
    await fastify.store.persist();
    return next;
  });

  fastify.post("/tick", async (request, reply) => {
    const body = asRecord(request.body);
    // 互換ルート（POST /v1/user/spot/order）と同じ pairAssets で弾く。ここは外向きに
    // 出ない口だが、状態ファイル由来の文字種が不正なペアを runTick へ渡すと、
    // fillOrder が INVALID_PAIR を返して applyFill が throw し 500 になる。
    if (!body || typeof body.pair !== "string" || !pairAssets(body.pair)) {
      return reply.code(400).send({ error: "INVALID_PAIR" });
    }
    const store = fastify.store;
    const lastMs = Date.parse(store.state().lastTickAt);
    const nowMs = Math.max(Date.now(), lastMs + 60_000);
    let candle: Candle;
    if (body.candle !== undefined) {
      const raw = asRecord(body.candle);
      if (!raw) return reply.code(400).send({ error: "INVALID_CANDLE" });
      candle = {
        open: Number(raw.open),
        high: Number(raw.high),
        low: Number(raw.low),
        close: Number(raw.close),
        vol: Number(raw.vol ?? 0),
        timestamp: raw.timestamp === undefined ? nowMs : Number(raw.timestamp),
      };
    } else if (body.price !== undefined) {
      const price = Number(body.price);
      candle = syntheticCandle(price, nowMs);
    } else {
      return reply.code(400).send({ error: "INVALID_CANDLE" });
    }
    if (!isValidCandle(candle)) return reply.code(400).send({ error: "INVALID_CANDLE" });

    const r = runTick(store.state(), {
      candles: [candle],
      nowMs: Math.max(nowMs, candle.timestamp),
      pair: body.pair,
      feeRate: store.feeRate,
    });
    if (!r.success) return reply.code(400).send({ error: r.error });
    store.replace(r.data.state);
    await store.persist();
    return { filled: r.data.filled.map(formatTrade), lastTickAt: r.data.lastTickAt };
  });

  fastify.post("/orders/:order_id/fill", async (request, reply) => {
    const orderId = String((request.params as { order_id: string }).order_id);
    const body = asRecord(request.body) ?? {};
    const store = fastify.store;
    const order = store.state().orders.find((o) => o.id === orderId);
    if (!order) return reply.code(404).send({ error: "ORDER_NOT_FOUND" });
    if (!isActive(order)) {
      return reply.code(409).send({ error: "ORDER_NOT_ACTIVE", status: order.status });
    }

    const remaining = remainingOf(order);
    const digits = precisionOf(order.pair);
    const price = body.price === undefined ? order.price : Number(body.price);
    if (price == null || !Number.isFinite(price) || price <= 0) {
      return reply.code(400).send({ error: "INVALID_PRICE" });
    }
    if (body.price !== undefined && !fitsDigits(price, digits.priceDigits)) {
      return reply.code(400).send({ error: "INVALID_PRICE" });
    }

    let amount = remaining;
    if (body.amount !== undefined) {
      amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > remaining) {
        return reply.code(400).send({ error: "INVALID_AMOUNT", remaining });
      }
      if (!fitsDigits(amount, digits.amountDigits)) {
        return reply.code(400).send({ error: "INVALID_AMOUNT", remaining });
      }
    }

    const before = store.state();
    const r = fillOrder(before, orderId, price, amount, new Date().toISOString(), store.feeRate);
    if (!r.success) {
      if (r.error === "INVALID_AMOUNT") {
        return reply.code(400).send({ error: "INVALID_AMOUNT", remaining });
      }
      if (r.error === "INVALID_PRICE") return reply.code(400).send({ error: "INVALID_PRICE" });
      if (r.error === "ORDER_NOT_ACTIVE") {
        return reply.code(409).send({ error: "ORDER_NOT_ACTIVE", status: order.status });
      }
      return reply.code(400).send({ error: r.error });
    }
    store.replace(r.data.state);
    await store.persist();
    return {
      order: formatOrder(r.data.order),
      trade: r.data.trade ? formatTrade(r.data.trade) : null,
    };
  });
};
