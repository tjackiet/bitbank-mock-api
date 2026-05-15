import type { FastifyPluginAsync } from "fastify";
import { ActiveOrdersQuerySchema } from "../schemas/requests.ts";
import { err, ErrorCode, ok } from "./envelope.ts";
import { formatOpenOrder } from "./format.ts";

export const activeOrdersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/v1/user/spot/active_orders", async (request, reply) => {
    const parsed = ActiveOrdersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return err(ErrorCode.INVALID_PARAMETER);
    }
    await fastify.store.tick();
    const open = fastify.store.state().openOrders;
    const filtered = parsed.data.pair ? open.filter((o) => o.pair === parsed.data.pair) : open;
    return ok({ orders: filtered.map(formatOpenOrder) });
  });
};
