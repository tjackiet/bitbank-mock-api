import type { Candle } from "./candles.ts";
import { isValidCandle } from "./candles.ts";
import {
  DEFAULT_TAKER_FEE_RATE,
  type OrderRecord,
  type PaperState,
  remainingOf,
  type TradeRecord,
} from "./state.ts";
import { fillOrder } from "./transitions.ts";
import { type Logger, noopLogger, type Result } from "./types.ts";

const ONE_MIN_MS = 60_000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * active な注文へ 1 本の足で全量約定を適用する。**失敗は throw せず `Result` で返す。**
 *
 * かつてはここで throw していたが、**投げ先が無い**。`runTick()` を呼ぶのは
 * `POST /_control/tick` と `SessionStore.tick()` の 2 つで、後者は互換ルートの先頭から
 * 走る。throw はハンドラの未捕捉例外になるので、`/v1/user/...` が bitbank 封筒でない
 * 500（`{"statusCode":500,...}`）を返していた。劣化中も通す読み取り経路である
 * `POST /v1/user/spot/orders_info`（注文状態の照合の主経路）まで落ちる。
 *
 * 到達する state ファイルは 2 つ実測している。どちらも docs/fidelity.md が
 * 「起動はするが 500 にはならない」と書いていたものである。
 *
 * - `nextTradeSeq` が安全整数を使い切った状態（`fillOrder` が `TRADE_SEQ_EXHAUSTED`）。
 *   「履歴は読めて新しい発注だけが断られる」はずだったが、market モードでは
 *   `GET /v1/user/assets` も `orders_info` も 500 だった。
 * - v1 / v2 から移行した `startAmount == 0` の指値（`fillOrder` が `INVALID_AMOUNT`）。
 *   前提の破れとして warn で起動する状態で、「起動後に 500 や書き換えを起こさない」
 *   はずだった。
 *
 * 呼び出し側は既に失敗を扱える（`POST /_control/tick` は 400、`SessionStore.tick()` は
 * warn して次のペアへ進む）ので、`Result` を返せば封筒と素の JSON の約束を両方とも保てる。
 *
 * 注文 id は state ファイル由来の任意の文字列なので、メッセージへ入れるときは JSON で包む
 * （この文字列は `SessionStore.tick()` の warn にそのまま載るため。改行で行を割らせない）。
 */
export function applyFill(
  state: PaperState,
  orderId: string,
  candle: Candle,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): Result<{ state: PaperState; trade: TradeRecord }> {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) {
    return { success: false, error: `applyFill: order ${JSON.stringify(orderId)} not found` };
  }
  if (order.price == null) {
    return {
      success: false,
      error: `applyFill: order ${JSON.stringify(orderId)} has no limit price`,
    };
  }
  const at = new Date(candle.timestamp + ONE_MIN_MS).toISOString();
  const r = fillOrder(state, orderId, order.price, remainingOf(order), at, feeRate);
  if (!r.success) return { success: false, error: `applyFill: ${r.error}` };
  if (!r.data.trade) return { success: false, error: "applyFill: missing trade" };
  return { success: true, data: { state: r.data.state, trade: r.data.trade } };
}

export type RunTickOptions = {
  candles: Candle[];
  nowMs: number;
  pair?: string;
  feeRate?: number;
  logger?: Logger;
};

export type RunTickResult = {
  state: PaperState;
  filled: TradeRecord[];
  lastTickAt: string;
};

export function runTick(state: PaperState, opts: RunTickOptions): Result<RunTickResult> {
  const { nowMs, candles, pair } = opts;
  if (candles.some((c) => !isValidCandle(c))) {
    return { success: false, error: "INVALID_CANDLE" };
  }
  const feeRate = opts.feeRate ?? DEFAULT_TAKER_FEE_RATE;
  const logger = opts.logger ?? noopLogger;
  const newLastTickAt = new Date(nowMs).toISOString();
  let fromMs = Math.min(Date.parse(state.lastTickAt), nowMs);
  if (nowMs - fromMs > MAX_LOOKBACK_MS) {
    // `lastTickAt` は state ファイル由来の任意の文字列で、`Date.parse` は
    // `"Jan 1 2020 (\n...)"` のような改行入りの表記も解釈する。ログには生の値を出さない
    // （src/store/session.ts・src/engine/persist.ts の warn と同じ扱い）。
    logger.warn(`gap > 24h; limiting to last 24h (lastTickAt=${JSON.stringify(state.lastTickAt)})`);
    fromMs = nowMs - MAX_LOOKBACK_MS;
  }
  let working: PaperState = { ...state };
  const filled: TradeRecord[] = [];
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  for (const candle of sorted) {
    if (candle.timestamp < fromMs || candle.timestamp > nowMs) continue;
    const orders = working.orders.filter(
      (o) =>
        (o.status === "UNFILLED" || o.status === "PARTIALLY_FILLED") &&
        (!pair || o.pair === pair) &&
        Date.parse(o.orderedAt) <= candle.timestamp,
    );
    for (const o of orders) {
      if (!matches(o, candle)) continue;
      const r = applyFill(working, o.id, candle, feeRate);
      // 1 件でも適用できなければ、組み立て途中の `working` は捨てて失敗を返す。
      // 状態を変えないので、断られた側は state ファイルを直してから流し直せる。
      if (!r.success) return { success: false, error: r.error };
      working = r.data.state;
      filled.push(r.data.trade);
    }
  }
  if (filled.length > 0) logger.info(`filled ${filled.length} order(s)`);
  working = { ...working, lastTickAt: newLastTickAt, updatedAt: newLastTickAt };
  return { success: true, data: { state: working, filled, lastTickAt: newLastTickAt } };
}

function matches(order: OrderRecord, candle: Candle): boolean {
  if (order.price == null) return false;
  return order.side === "buy" ? candle.low <= order.price : candle.high >= order.price;
}
