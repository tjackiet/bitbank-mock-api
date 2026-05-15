import type { FastifyPluginAsync } from "fastify";
import { TradeHistoryQuerySchema } from "../schemas/requests.ts";
import { err, ErrorCode, ok } from "./envelope.ts";
import { formatTrade } from "./format.ts";

export const tradeHistoryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/v1/user/spot/trade_history", async (request, reply) => {
    const parsed = TradeHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return err(ErrorCode.INVALID_PARAMETER);
    }
    await fastify.store.tick();
    let history = [...fastify.store.state().history].reverse();
    if (parsed.data.pair) history = history.filter((h) => h.pair === parsed.data.pair);
    if (parsed.data.count !== undefined) history = history.slice(0, parsed.data.count);
    return ok({ trades: history.map(formatTrade) });
  });
};
