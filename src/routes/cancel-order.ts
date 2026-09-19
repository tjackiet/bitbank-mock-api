import type { FastifyPluginAsync } from "fastify";
import { isActive, type OrderRecord } from "../engine/state.ts";
import { cancelOrder } from "../engine/transitions.ts";
import { CancelOrderRequestSchema, CancelOrdersRequestSchema } from "../schemas/requests.ts";
import { ErrorCode, err, ok } from "./envelope.ts";
import { formatOrder } from "./format.ts";
import { asRecord, isMissing } from "./params.ts";

function terminalCancelCode(order: OrderRecord): number | null {
  if (order.status === "CANCELED_UNFILLED" || order.status === "CANCELED_PARTIALLY_FILLED") {
    return ErrorCode.ALREADY_CANCELED;
  }
  if (order.status === "FULLY_FILLED") return ErrorCode.ALREADY_EXECUTED;
  if (order.status === "REJECTED") return ErrorCode.ORDER_NOT_FOUND;
  return null;
}

export const cancelOrderRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/v1/user/spot/cancel_order", async (request) => {
    const body = asRecord(request.body);
    if (!body) {
      return err(ErrorCode.INVALID_PARAMETER);
    }
    if (isMissing(body.order_id)) {
      return err(ErrorCode.MISSING_ORDER_ID);
    }
    const parsed = CancelOrderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return err(ErrorCode.INVALID_PARAMETER);
    }
    const store = fastify.store;
    await store.tick();
    const wantId = String(parsed.data.order_id);
    const target = store.state().orders.find((o) => o.id === wantId && o.pair === parsed.data.pair);
    if (!target) return err(ErrorCode.ORDER_NOT_FOUND);
    const terminal = terminalCancelCode(target);
    if (terminal !== null) return err(terminal);
    if (!isActive(target)) return err(ErrorCode.ORDER_NOT_FOUND);
    const r = cancelOrder(store.state(), wantId, new Date().toISOString());
    if (!r.success) return err(ErrorCode.ORDER_NOT_FOUND);
    await store.commit(r.data.state);
    return ok(formatOrder(r.data.order));
  });

  fastify.post("/v1/user/spot/cancel_orders", async (request) => {
    const body = asRecord(request.body);
    if (!body) {
      return err(ErrorCode.INVALID_PARAMETER);
    }
    if (isMissing(body.order_ids)) {
      return err(ErrorCode.MISSING_ORDER_IDS);
    }
    const parsed = CancelOrdersRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return err(ErrorCode.INVALID_PARAMETER);
    }
    const store = fastify.store;
    await store.tick();
    const wantIds = parsed.data.order_ids.map((i) => String(i));
    const working = store.state();
    const toCancel: string[] = [];
    for (const id of wantIds) {
      const target = working.orders.find((o) => o.id === id && o.pair === parsed.data.pair);
      // そのペアの注文に解決しない id（存在しない / 別のペア）は黙って飛ばす。
      // エラーにはせず、解決した分だけ取り消す（docs/fidelity.md の同行）。
      if (!target) continue;
      const terminal = terminalCancelCode(target);
      if (terminal !== null) return err(terminal);
      if (isActive(target)) toCancel.push(id);
    }
    if (toCancel.length === 0) return err(ErrorCode.ORDER_NOT_FOUND);

    const now = new Date().toISOString();
    let next = working;
    const canceled = [];
    for (const id of toCancel) {
      const r = cancelOrder(next, id, now);
      // 失敗を読み飛ばす経路は**同じ id が order_ids に 2 回以上来たとき**に踏む。
      // `toCancel` は重複を落とさないので同じ id が並び、2 件目以降は直前の取消で
      // 終端になった注文に当たって `ORDER_NOT_ACTIVE` で失敗する。防御的な保険ではなく
      // 到達するので、消さないこと。
      // 応答の `orders` が `order_ids` より短くなる理由はこれだけではない。上の
      // `if (!target) continue;` が、存在しない id と別のペアの id も飛ばす
      // （3 つとも docs/fidelity.md の「取消済み・約定済みの取消」節に記録した）。
      if (!r.success) continue;
      next = r.data.state;
      canceled.push(r.data.order);
    }
    if (canceled.length === 0) return err(ErrorCode.ORDER_NOT_FOUND);
    await store.commit(next);
    return ok({ orders: canceled.map(formatOrder) });
  });
};
