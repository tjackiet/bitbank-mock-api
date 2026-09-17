import type { FastifyPluginAsync } from "fastify";
import { fitsDigits, precisionOf } from "../engine/precision.ts";
import { pairAssets } from "../engine/state.ts";
import { placeOrder, TransitionError } from "../engine/transitions.ts";
import { CreateOrderRequestSchema } from "../schemas/requests.ts";
import { err, ErrorCode, ok } from "./envelope.ts";
import { formatOrder } from "./format.ts";
import { asRecord, isMissing } from "./params.ts";

/**
 * 欠落しているパラメータに対応するコード。無ければ `null`。
 *
 * **`pair` の欠落がこの経路で `30009` になることは実測していない。** 実 API で確かめたのは
 * `GET /v1/user/spot/order` と `POST /v1/user/spot/orders_info` の 2 つで、どちらも `30009`
 * を返した（2026-09-17）。発注 API は実弾になるので測っていない。errors.md の `30009` が
 * "Missing asset." という汎用の文言であることと、上の 2 経路に揃えることを根拠にしている。
 *
 * **並び順（どれが先に返るか）も実測していない。** `pair` を先頭に置いたのは rest-api.md の
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
  fastify.post("/v1/user/spot/order", async (request, reply) => {
    const missing = missingCreateOrderCode(request.body);
    if (missing !== null) {
      reply.code(400);
      return err(missing);
    }
    const parsed = CreateOrderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return err(ErrorCode.INVALID_PARAMETER);
    }
    const { pair, side, type, amount, price } = parsed.data;
    if (!pairAssets(pair)) return err(ErrorCode.INVALID_ASSET);

    const digits = precisionOf(pair);
    if (!fitsDigits(amount, digits.amountDigits)) return err(ErrorCode.AMOUNT_PRECISION);
    if (type === "limit" && price !== undefined && !fitsDigits(price, digits.priceDigits)) {
      reply.code(400);
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
