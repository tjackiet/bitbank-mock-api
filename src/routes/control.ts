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
 * **この判定を `request.ip` に戻してはいけない。** `request.ip` は Fastify の `trustProxy` を
 * 有効にすると `X-Forwarded-For` の値を返すので、そちらを使うと、ヘッダに `127.0.0.1` を
 * 書いた非ループバックの要求がトークン無しでこの境界を通る（`trustProxy` を設定するか
 * どうかはログの都合で決まる話で、control の許可判定がそれに左右されてはならない）。
 * ソケットから直接読む限り、`buildServer()` の `trustProxy` の有無で境界は変わらない。
 */
function clientIp(request: FastifyRequest): string | undefined {
  return request.socket.remoteAddress;
}

/**
 * `X-Control-Token` の値。ヘッダ行が無いときと 2 行以上あるときは `null`。
 *
 * Node は `set-cookie` 以外の同名ヘッダが複数行来ると `request.headers` 側では `", "` で
 * 繋いだ 1 本の文字列にする。繋いだ結果がたまたま設定値と一致する形（`part1, part2`）に
 * なり得るので、行数は生ヘッダで数えて、ちょうど 1 本のときだけ値を返す。
 */
export function controlTokenHeader(request: FastifyRequest): string | null {
  const raw = request.raw.rawHeaders;
  let found: string | null = null;
  let count = 0;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() !== "x-control-token") continue;
    count += 1;
    found = raw[i + 1]!;
  }
  return count === 1 ? found : null;
}

/**
 * `X-Control-Token` が設定値と一致するか。一致しない位置が先頭か末尾かで比較時間が
 * 変わらないよう `timingSafeEqual` で見る（長さの違いは隠せないので、トークンは
 * 固定長で運用する）。
 */
function tokenMatches(given: string, expected: string): boolean {
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

/**
 * `/_control/` の実験用ルート群。bitbank API には存在しないので、応答は bitbank 封筒に
 * 包まず素の JSON で返し、失敗は HTTP ステータス（400 / 403 / 404 / 409）で表す。
 * 登録は `BITBANK_MOCK_CONTROL=1` のときだけ（src/server/http.ts の `buildServer()`）。
 */
export const controlRoutes: FastifyPluginAsync<ControlRouteOptions> = async (fastify, opts) => {
  /**
   * 許可判定。ループバックからは無条件に通し、それ以外は `X-Control-Token` が
   * `opts.token` と一致するときだけ通す。トークン未設定なら非ループバックは常に 403。
   */
  fastify.addHook("onRequest", async (request, reply) => {
    if (isLoopback(clientIp(request))) return;
    const expected = opts.token;
    const given = controlTokenHeader(request);
    if (!expected || given === null || !tokenMatches(given, expected)) {
      return reply.code(403).send({ error: "FORBIDDEN" });
    }
  });

  /** `PaperState` をそのまま返す（デバッグ用）。 */
  fastify.get("/state", async () => fastify.store.state());

  /**
   * 状態を初期化する。`initialJpy` は非負の有限数、`balances` は資産キーが
   * `[a-z0-9]+` で値が非負の有限数のときだけ受け、外れたら 400 `INVALID_BALANCES` を
   * 返して状態は変えない。検査を通ったときだけ差し替えて状態ファイルへ書く。
   */
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
