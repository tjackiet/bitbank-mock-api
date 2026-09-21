import type { FastifyPluginAsync } from "fastify";
import { isKnownPair } from "../engine/pairs.ts";
import { GetOrderQuerySchema, OrdersInfoRequestSchema } from "../schemas/requests.ts";
import { ErrorCode, err, ok } from "./envelope.ts";
import { formatOrder } from "./format.ts";
import { asRecord, isMissing, isOrderIdArray, isOrderIdValue } from "./params.ts";

export const orderInfoRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/v1/user/spot/order", async (request) => {
    const query = asRecord(request.query) ?? {};
    if (isMissing(query.order_id)) {
      return err(ErrorCode.MISSING_ORDER_ID);
    }
    if (isMissing(query.pair)) {
      return err(ErrorCode.MISSING_ASSET);
    }
    // 実 API は「読めない id」を `40013` で弾き、「読めたが存在しない id」の `50009` と
    // 分けている（2026-09-17 実測。`order_id=true` / `1.5` / 同名 2 本はいずれも `40013`）。
    // スキーマ検証より**前**に置く。同名 2 本は配列になってスキーマが `20003` で落とすが、
    // 実 API はそれも `40013` を返すため。
    if (!isOrderIdValue(query.order_id)) {
      return err(ErrorCode.INVALID_ORDER_ID);
    }
    const parsed = GetOrderQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      // **ここへ落ちるのは `pair` だけである。** `order_id` は上の `isOrderIdValue()` が
      // 先に見ており、欠落は `isMissing()` が `30006` / `30009` で拾う。したがって残る
      // `pair` は必ず「あって、文字列でない」（同名クエリ 2 本で配列になった場合）——
      // **欠落と迷う余地が無いので `40017` に寄せる**。`orders_info` が
      // `typeof body.pair !== "string"` を `40017` で断るのと同じ判断で、そちらは実測済み
      // （`docs/fidelity.md` の「エラーコード」節）。
      const bad = new Set(parsed.error.issues.map((i) => i.path[0]));
      return err(bad.has("pair") ? ErrorCode.INVALID_ASSET : ErrorCode.INVALID_PARAMETER);
    }
    // 公式一覧に無いペアは `40017`。実 API がこの経路で `xxx_yyy` に `40017` を返すことは
    // 実測済み（`docs/fidelity.md` の「ペア」節）。スキーマ検証の**後**に置いているのは、
    // 他の不正な値と重なったときどちらが勝つかを実測していないため。既存の（実測済みの）
    // 優先順を動かさない位置に足した。
    if (!isKnownPair(parsed.data.pair)) return err(ErrorCode.INVALID_ASSET);
    await fastify.store.tick();
    const wantId = String(parsed.data.order_id);
    const found = fastify.store
      .state()
      .orders.find((o) => o.id === wantId && o.pair === parsed.data.pair);
    if (!found) return err(ErrorCode.ORDER_NOT_FOUND);
    return ok(formatOrder(found));
  });

  fastify.post("/v1/user/spot/orders_info", async (request) => {
    const body = asRecord(request.body);
    // 本文そのものが object でない。**どのフィールドの問題かを言えない**ので `20003` 据え置き
    // （`docs/fidelity.md` の「エラーコード」節）。
    if (!body) {
      return err(ErrorCode.INVALID_PARAMETER);
    }
    if (isMissing(body.order_ids)) {
      return err(ErrorCode.MISSING_ORDER_IDS);
    }
    if (isMissing(body.pair)) {
      return err(ErrorCode.MISSING_ASSET);
    }
    // 実 API は `order_ids` が id の配列でなければ `40014`（2026-09-17 実測。`"1"` /
    // `1` / `[1.5]` / `[]`）。**空配列も弾かれる**点がモックとの一番大きな差で、
    // 以前は `success: 1` と空の一覧を返していた。注文状態の照合の主経路である。
    if (!isOrderIdArray(body.order_ids)) {
      return err(ErrorCode.INVALID_ORDER_ID_ARRAY);
    }
    // `pair` が文字列ですらないときも実 API は `40017` を返す（`pair: true` で実測）。
    // スキーマ検証に任せると `20003` になるので、ここで型ごと見る。
    if (typeof body.pair !== "string" || !isKnownPair(body.pair)) {
      return err(ErrorCode.INVALID_ASSET);
    }
    const parsed = OrdersInfoRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // **この経路は現状どの入力でも踏まない。** 上の 3 つの検査が `pair` と `order_ids` を
      // スキーマより厳しく見ているので、ここへ来る本文は必ず両方を満たしている
      // （`isOrderIdArray()` は `idValue` より狭く、`pair` は文字列であることまで確かめ済み）。
      // **フィールドを特定できる経路が無いので `20003` 据え置き**にする。スキーマだけが
      // 変わったときの保険として残すので、消さないこと。
      return err(ErrorCode.INVALID_PARAMETER);
    }
    await fastify.store.tick();
    const byId = new Map(fastify.store.state().orders.map((o) => [o.id, o]));
    const orders = [];
    for (const rawId of parsed.data.order_ids) {
      const order = byId.get(String(rawId));
      if (order && order.pair === parsed.data.pair) orders.push(formatOrder(order));
    }
    return ok({ orders });
  });
};
