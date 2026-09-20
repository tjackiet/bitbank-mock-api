import type { FastifyPluginAsync } from "fastify";
import { isKnownPair, isOrderSuspendedPair } from "../engine/pairs.ts";
import { fitsDigits, precisionOf } from "../engine/precision.ts";
import { activeOrders, pairAssets } from "../engine/state.ts";
import { placeOrder, TransitionError } from "../engine/transitions.ts";
import { CreateOrderRequestSchema } from "../schemas/requests.ts";
import { ErrorCode, err, ok } from "./envelope.ts";
import { formatOrder } from "./format.ts";
import { asRecord, isMissing } from "./params.ts";

/**
 * 同時に持てる未約定注文の本数の上限。公式のエラー定義が持つ値そのもの
 * （`errors.md:202` "Too many Simultaneous orders, current limit is 30."、
 * `errors_JP.md:202`「同時発注制限件数(30件)を上回っています」。コミット `0badd680`）。
 *
 * **公式が固定値として文言に埋めているので、設定可能にしない。**
 *
 * **`cancel_orders` の `MAX_CANCEL_ORDER_IDS` とは別の制限で、同じ 30 でも数える対象が違う。**
 * あちらは 1 要求あたりの `order_ids` の件数（超過は `40015`）、こちらは口座が同時に持てる
 * 未約定注文の本数（超過は `60011`）。**値が揃っているのは偶然なので、片方を動かすときに
 * もう片方を追従させない**（`docs/fidelity.md` の「同時未約定注文の上限」節）。
 */
export const MAX_ACTIVE_ORDERS = 30;

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
    // 発注停止のペア（公式 `pairs.md` の "Order suspended flag (delisted)" が `true` の
    // 18 ペア）は新規発注を断る。**fail-closed である**——本番で成立しない注文を成功させると、
    // 利用側が「成功する」という契約を学習してしまう。コードは `errors.md:225` の
    // `70017`「Orders on pair have been suspended.」で、**停止ペアへ実際に発注したときの
    // コードは実測していない**（発注は実弾になるため）。
    //
    // **取消経路には同じ検査を置かない。** 公式は `stop_order`（"order suspended flag"）と
    // `stop_order_and_cancel`（"order **and cancel** suspended flag"）を書き分けており
    // （`rest-api.md:1696-1697`）、前者だけから取消の禁止は読めない。照会も従来どおり通す。
    //
    // 位置は実在性の検査の直後（どちらもペアそのものの可否）で、桁の検査より前。
    // **桁と同時に不正なときどちらのコードが勝つかは実測していない**（`docs/fidelity.md` の
    // 「ペア」節）。`store.tick()` より前なので、断ったときに状態は一切変わらない。
    if (isOrderSuspendedPair(pair)) return err(ErrorCode.PAIR_ORDER_SUSPENDED);

    const digits = precisionOf(pair);
    if (!fitsDigits(amount, digits.amountDigits)) return err(ErrorCode.AMOUNT_PRECISION);
    if (type === "limit" && price !== undefined && !fitsDigits(price, digits.priceDigits)) {
      return err(ErrorCode.INVALID_PARAMETER);
    }

    const store = fastify.store;
    // 未約定注文の本数の上限。**`store.tick()` より前**に見るので、断ったときに状態は
    // 一切変わらない（`isOrderSuspendedPair()` と `cancel_orders` の件数上限と同じ位置づけ）。
    //
    // 数え方は `activeOrders()` をそのまま使う——`STATUS_KIND` が `"active"` に分類する
    // `UNFILLED` と `PARTIALLY_FILLED` だけを数え、`INACTIVE`（`"pending"`）と終端は数えない
    // （新しい「active の定義」を作らないため。`src/engine/state.ts` の `STATUS_KIND`）。
    // **単位は口座全体で、ペアで分けない。** 公式の文言が "Simultaneous orders" でペアに
    // 言及せず、口座全体の方が制限が強く fail-closed 側に倒れるためである。**推測であり、
    // Plan A の契約範囲（`btc_jpy` の指値）ではペア単位と区別が付かない。**
    //
    // 位置を桁の検査より**後ろ**にしたのは、`cancel_orders` の件数上限をスキーマ検証の後に
    // 置いたのと同じ理由で、既存の（実測済みの）優先順を動かさないため。**桁や停止ペアと
    // 同時に上限へ当たったときどちらのコードが勝つかは実測していない。**
    //
    // `tick()` の前で数えるので、**その tick が埋めたはずの注文はまだ active のまま数える**。
    // market モードで 31 本目の直前に枠が空く局面では、本物より厳しく断る側へ倒れる（fail-closed）。
    // **成行の新規発注もこの検査を通る**（その場で全量約定して active に残らないが、
    // 受ける時点では 1 本の新規注文である）。実 API が成行を数から除くかは分からない。
    if (activeOrders(store.state()).length >= MAX_ACTIVE_ORDERS) {
      return err(ErrorCode.TOO_MANY_SIMULTANEOUS_ORDERS);
    }
    await store.tick();

    const now = new Date().toISOString();
    if (type === "market") {
      const fillPrice = await store.getLatestPrice(pair);
      if (fillPrice === null) return err(ErrorCode.INTERNAL);
      const r = placeOrder(
        store.state(),
        { pair, side, type, amount },
        now,
        fillPrice,
        store.feeRate,
      );
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
