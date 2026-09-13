import { timingSafeEqual } from "node:crypto";
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

/**
 * 接続元のアドレス。TCP の対向アドレスだけを見る。
 *
 * Fastify の `request.ip` は `trustProxy` を有効にすると `X-Forwarded-For` の値を返すように
 * なる。それを許可判定に使うと、ヘッダに `127.0.0.1` を書いた非ループバックの要求が
 * トークン無しでこの境界を通る。control の許可判定はサーバのプロキシ設定に左右されて
 * ならないので、ソケットから直接読む。
 *
 * `buildServer()`（src/server/http.ts）は `trustProxy` を設定しない。**有効にしてはいけない。**
 */
function clientIp(request: FastifyRequest): string | undefined {
  return request.socket.remoteAddress;
}

/**
 * `X-Control-Token` が設定値と一致するか。一致しない位置が先頭か末尾かで比較時間が
 * 変わらないよう `timingSafeEqual` で見る（長さの違いは隠せないので、トークンは
 * 固定長で運用する）。ヘッダが複数回来た場合は文字列にならないので不一致とする。
 */
function tokenMatches(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 残高の資産キーに許す文字種。互換ルートが作る資産名はペアのセグメント
 * （`[a-z0-9]+`、src/engine/state.ts の `pairAssets`）に限られるので、control からも
 * 同じ形しか入れない。ここを開けると、空文字・改行入り・大文字の資産名が
 * `GET /v1/user/assets` の `asset` に現れ、状態ファイルにも残る。
 */
const ASSET_KEY_RE = /^[a-z0-9]+$/;

function syntheticCandle(price: number, timestamp: number): Candle {
  return { open: price, high: price, low: price, close: price, vol: 0, timestamp };
}

export const controlRoutes: FastifyPluginAsync<ControlRouteOptions> = async (fastify, opts) => {
  fastify.addHook("onRequest", async (request, reply) => {
    if (isLoopback(clientIp(request))) return;
    const expected = opts.token;
    const given = request.headers["x-control-token"];
    if (!expected || !tokenMatches(given, expected)) {
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
        if (!ASSET_KEY_RE.test(asset)) {
          return reply.code(400).send({ error: "INVALID_BALANCES" });
        }
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
