import type { FastifyPluginAsync } from "fastify";
import { CancelOrderRequestSchema, CancelOrdersRequestSchema } from "../schemas/requests.ts";
import { err, ErrorCode, ok } from "./envelope.ts";
import { formatCanceledOrder } from "./format.ts";

export const cancelOrderRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/v1/user/spot/cancel_order", async (request, reply) => {
    const parsed = CancelOrderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return err(ErrorCode.INVALID_PARAMETER);
    }
    const store = fastify.store;
    await store.tick();
    const wantId = String(parsed.data.order_id);
    const state = store.state();
    const target = state.openOrders.find(
      (o) => o.id === wantId && o.pair === parsed.data.pair,
    );
    if (!target) return err(ErrorCode.ORDER_NOT_FOUND);
    store.replace({
      ...state,
      openOrders: state.openOrders.filter((o) => o.id !== target.id),
    });
    await store.persist();
    return ok(formatCanceledOrder(target));
  });

  fastify.post("/v1/user/spot/cancel_orders", async (request, reply) => {
    const parsed = CancelOrdersRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return err(ErrorCode.INVALID_PARAMETER);
    }
    const store = fastify.store;
    await store.tick();
    const wantIds = new Set(parsed.data.order_ids.map((i) => String(i)));
    const state = store.state();
    const targets = state.openOrders.filter(
      (o) => wantIds.has(o.id) && o.pair === parsed.data.pair,
    );
    if (targets.length === 0) return err(ErrorCode.ORDER_NOT_FOUND);
    const targetIds = new Set(targets.map((o) => o.id));
    store.replace({
      ...state,
      openOrders: state.openOrders.filter((o) => !targetIds.has(o.id)),
    });
    await store.persist();
    return ok({ orders: targets.map(formatCanceledOrder) });
  });
};
