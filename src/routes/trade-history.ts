import type { FastifyPluginAsync } from "fastify";
import type { TradeRecord } from "../engine/state.ts";
import { TradeHistoryQuerySchema } from "../schemas/requests.ts";
import { err, ErrorCode, ok } from "./envelope.ts";
import { formatTrade } from "./format.ts";

const TRADE_HISTORY_MAX = 1000;

function filterTrades(
  trades: TradeRecord[],
  q: {
    pair?: string;
    count?: number;
    order_id?: number | string;
    since?: number;
    end?: number;
    order?: "asc" | "desc";
  },
): TradeRecord[] {
  let out = trades;
  if (q.pair) out = out.filter((t) => t.pair === q.pair);
  if (q.order_id !== undefined) {
    const want = String(q.order_id);
    out = out.filter((t) => t.orderId === want);
  }
  if (q.since !== undefined) {
    out = out.filter((t) => Date.parse(t.executedAt) >= q.since!);
  }
  if (q.end !== undefined) {
    out = out.filter((t) => Date.parse(t.executedAt) <= q.end!);
  }
  if ((q.order ?? "desc") === "desc") out = [...out].reverse();
  const limit = q.count === undefined ? out.length : Math.min(q.count, TRADE_HISTORY_MAX);
  return out.slice(0, limit);
}

export const tradeHistoryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/v1/user/spot/trade_history", async (request, reply) => {
    const parsed = TradeHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return err(ErrorCode.INVALID_PARAMETER);
    }
    await fastify.store.tick();
    const trades = filterTrades(fastify.store.state().trades, parsed.data);
    return ok({ trades: trades.map(formatTrade) });
  });
};
