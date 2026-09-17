import type { FastifyPluginAsync } from "fastify";
import { GetOrderQuerySchema, OrdersInfoRequestSchema } from "../schemas/requests.ts";
import { err, ErrorCode, ok } from "./envelope.ts";
import { formatOrder } from "./format.ts";
import { asRecord, isMissing } from "./params.ts";

export const orderInfoRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/v1/user/spot/order", async (request) => {
    const query = asRecord(request.query) ?? {};
    if (isMissing(query.order_id)) {
      return err(ErrorCode.MISSING_ORDER_ID);
    }
    if (isMissing(query.pair)) {
      return err(ErrorCode.MISSING_ASSET);
    }
    const parsed = GetOrderQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return err(ErrorCode.INVALID_PARAMETER);
    }
    await fastify.store.tick();
    const wantId = String(parsed.data.order_id);
    const found = fastify.store.state().orders.find(
      (o) => o.id === wantId && o.pair === parsed.data.pair,
    );
    if (!found) return err(ErrorCode.ORDER_NOT_FOUND);
    return ok(formatOrder(found));
  });

  fastify.post("/v1/user/spot/orders_info", async (request) => {
    const body = asRecord(request.body);
    if (!body) {
      return err(ErrorCode.INVALID_PARAMETER);
    }
    if (isMissing(body.order_ids)) {
      return err(ErrorCode.MISSING_ORDER_IDS);
    }
    if (isMissing(body.pair)) {
      return err(ErrorCode.MISSING_ASSET);
    }
    const parsed = OrdersInfoRequestSchema.safeParse(request.body);
    if (!parsed.success) {
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
