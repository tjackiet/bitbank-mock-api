import type { FastifyPluginAsync } from "fastify";
import { isActive } from "../engine/state.ts";
import { cancelOrder } from "../engine/transitions.ts";
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
    const target = state.orders.find((o) => o.id === wantId && o.pair === parsed.data.pair);
    if (!target || !isActive(target)) return err(ErrorCode.ORDER_NOT_FOUND);
    const r = cancelOrder(state, wantId, new Date().toISOString());
    if (!r.success) return err(ErrorCode.ORDER_NOT_FOUND);
    store.replace(r.data.state);
    await store.persist();
    return ok(formatCanceledOrder(r.data.order));
  });

  fastify.post("/v1/user/spot/cancel_orders", async (request, reply) => {
    const parsed = CancelOrdersRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return err(ErrorCode.INVALID_PARAMETER);
    }
    const store = fastify.store;
    await store.tick();
    const wantIds = parsed.data.order_ids.map((i) => String(i));
    const now = new Date().toISOString();
    let working = store.state();
    const canceled = [];
    for (const id of wantIds) {
      const target = working.orders.find((o) => o.id === id && o.pair === parsed.data.pair);
      if (!target || !isActive(target)) continue;
      const r = cancelOrder(working, id, now);
      if (!r.success) continue;
      working = r.data.state;
      canceled.push(r.data.order);
    }
    if (canceled.length === 0) return err(ErrorCode.ORDER_NOT_FOUND);
    store.replace(working);
    await store.persist();
    return ok({ orders: canceled.map(formatCanceledOrder) });
  });
};
