import type { FastifyPluginAsync } from "fastify";
import { fitsDigits, precisionOf } from "../engine/precision.ts";
import { isKnownPair } from "../engine/pairs.ts";
import { pairAssets } from "../engine/state.ts";
import { placeOrder, TransitionError } from "../engine/transitions.ts";
import { CreateOrderRequestSchema } from "../schemas/requests.ts";
import { err, ErrorCode, ok } from "./envelope.ts";
import { formatOrder } from "./format.ts";
import { asRecord, isMissing } from "./params.ts";

/**
 * 欠落しているパラメータに対応するコード。無ければ `null`。
 *
 * **`pair` の欠落が `30009` になることはこの経路でも実測済み**（2026-09-17）。`pair` を
 * 省いた `POST /v1/user/spot/order` は取引できる先が無いので注文が成立せず、実 API でも
 * 安全に測れた。`GET /v1/user/spot/order` と `POST /v1/user/spot/orders_info` と同じ
 * `30009`（"Missing asset."）が返る。
 *
 * **`pair` が空白だけ（`"   "`）のときは `40017`（"Invalid asset."）** で、これも実測済み。
 * `isMissing()` は trim しないので「欠落」ではなく「不正な値」の側へ落ち、`pairAssets()` が
 * 弾く。**この流れが実 API と一致していることを確かめた**（`src/routes/params.ts` の
 * `isMissing` の docstring も参照）。
 *
 * **並び順（どれが先に返るか）は実測していない。** `pair` を先頭に置いたのは rest-api.md の
 * パラメータ表の並びに合わせたもので、実 API の優先順の再現ではない。
 */
function missingCreateOrderCode(body: unknown): number | null {
  const b = asRecord(body);
  if (!b) return ErrorCode.INVALID_PARAMETER;
  if (isMissing(b.pair)) return ErrorCode.MISSING_ASSET;
  if (isMissing(b.amount)) return ErrorCode.MISSING_AMOUNT;
  if (isMissing(b.side)) return ErrorCode.MISSING_SIDE;
  if (isMissing(b.type)) return ErrorCode.MISSING_TYPE;
  if (b.type === "limit" && isMissing(b.price)) return ErrorCode.MISSING_PRICE;
  return null;
}

function mapPlaceError(error: string) {
  switch (error) {
    case TransitionError.INSUFFICIENT_FUNDS:
      return err(ErrorCode.INSUFFICIENT_FUNDS);
    case TransitionError.INVALID_PRICE:
    case TransitionError.LIMIT_PRICE_REQUIRED:
      return err(ErrorCode.INVALID_PARAMETER);
    case TransitionError.INVALID_AMOUNT:
      return err(ErrorCode.INVALID_PARAMETER);
    case TransitionError.INVALID_PAIR:
      return err(ErrorCode.INVALID_ASSET);
    case TransitionError.MARKET_PRICE_REQUIRED:
      return err(ErrorCode.INTERNAL);
    default:
      return err(ErrorCode.INTERNAL);
  }
}

export const createOrderRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/v1/user/spot/order", async (request) => {
    const missing = missingCreateOrderCode(request.body);
    if (missing !== null) {
      return err(missing);
    }
    const parsed = CreateOrderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return err(ErrorCode.INVALID_PARAMETER);
    }
    const { pair, side, type, amount, price } = parsed.data;
    // 2 段で弾く。文字種（`..` や `?` を外向きの足取得 URL へ入れない）と、公式一覧にあること。
    // どちらも `40017` を返す。文字種は `pair: "   "` で実測済み（上の docstring）。
    // **一覧に無いペアがこの経路で `40017` になることは実測していない**（発注は実弾になるため
    // 測れない）。照会 4 経路で `xxx_yyy` が `40017` だったことからの**外挿**である。
    // ここを素通しにすると、照会できない注文を作れてしまう（`GET order` は `40017` を返す）。
    // 詳しくは `docs/fidelity.md` の「ペア」節。
    if (!pairAssets(pair) || !isKnownPair(pair)) return err(ErrorCode.INVALID_ASSET);

    const digits = precisionOf(pair);
    if (!fitsDigits(amount, digits.amountDigits)) return err(ErrorCode.AMOUNT_PRECISION);
    if (type === "limit" && price !== undefined && !fitsDigits(price, digits.priceDigits)) {
      return err(ErrorCode.INVALID_PARAMETER);
    }

    const store = fastify.store;
    await store.tick();

    const now = new Date().toISOString();
    if (type === "market") {
      const fillPrice = await store.getLatestPrice(pair);
      if (fillPrice === null) return err(ErrorCode.INTERNAL);
      const r = placeOrder(store.state(), { pair, side, type, amount }, now, fillPrice, store.feeRate);
      if (!r.success) return mapPlaceError(r.error);
      await store.commit(r.data.state);
      return ok(formatOrder(r.data.order));
    }

    const r = placeOrder(
      store.state(),
      { pair, side, type, amount, price },
      now,
      undefined,
      store.feeRate,
    );
    if (!r.success) return mapPlaceError(r.error);
    await store.commit(r.data.state);
    return ok(formatOrder(r.data.order));
  });
};
