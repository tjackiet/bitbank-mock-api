import type { FastifyPluginAsync } from "fastify";
import { activeOrders, parseNumericId, type OrderRecord } from "../engine/state.ts";
import { ActiveOrdersQuerySchema } from "../schemas/requests.ts";
import { err, ErrorCode, ok } from "./envelope.ts";
import { queryParamErrorCode } from "./params.ts";
import { formatOrder } from "./format.ts";

function filterActiveOrders(
  orders: OrderRecord[],
  q: {
    pair?: string;
    count?: number;
    from_id?: number;
    end_id?: number;
    since?: number;
    end?: number;
  },
): OrderRecord[] {
  let out = orders;
  if (q.pair) out = out.filter((o) => o.pair === q.pair);
  if (q.from_id !== undefined) {
    out = out.filter((o) => {
      const id = parseNumericId(o.id);
      return id !== null && id >= q.from_id!;
    });
  }
  if (q.end_id !== undefined) {
    out = out.filter((o) => {
      const id = parseNumericId(o.id);
      return id !== null && id <= q.end_id!;
    });
  }
  if (q.since !== undefined) {
    out = out.filter((o) => Date.parse(o.orderedAt) >= q.since!);
  }
  if (q.end !== undefined) {
    out = out.filter((o) => Date.parse(o.orderedAt) <= q.end!);
  }
  if (q.count !== undefined) out = out.slice(0, q.count);
  return out;
}

export const activeOrdersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/v1/user/spot/active_orders", async (request) => {
    const parsed = ActiveOrdersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      // 絞り込みパラメータは実 API が専用コードを返すので、名前で引き当てる。
      const code = queryParamErrorCode(parsed.error.issues.map((i) => i.path[0]));
      return err(code ?? ErrorCode.INVALID_PARAMETER);
    }
    await fastify.store.tick();
    const filtered = filterActiveOrders(activeOrders(fastify.store.state()), parsed.data);
    return ok({ orders: filtered.map(formatOrder) });
  });
};
