import type { FastifyPluginAsync } from "fastify";
import { isKnownPair } from "../engine/pairs.ts";
import { activeOrders, type OrderRecord, parseNumericId } from "../engine/state.ts";
import { ActiveOrdersQuerySchema } from "../schemas/requests.ts";
import { ErrorCode, err, ok } from "./envelope.ts";
import { formatOrder } from "./format.ts";
import { queryParamErrorCode } from "./params.ts";

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
  // 境界は closure の外で受け直す。`q.X` のままだと TS が closure の中まで絞り込めず、
  // 非 null アサーションが要る（外へ出せば型でそのまま通る）。
  const { from_id: fromId, end_id: endId, since, end } = q;
  if (fromId !== undefined) {
    out = out.filter((o) => {
      const id = parseNumericId(o.id);
      return id !== null && id >= fromId;
    });
  }
  if (endId !== undefined) {
    out = out.filter((o) => {
      const id = parseNumericId(o.id);
      return id !== null && id <= endId;
    });
  }
  if (since !== undefined) {
    out = out.filter((o) => Date.parse(o.orderedAt) >= since);
  }
  if (end !== undefined) {
    out = out.filter((o) => Date.parse(o.orderedAt) <= end);
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
    // `pair` は任意。渡されていて公式一覧に無ければ `40017`（実測済み。`docs/fidelity.md` の
    // 「ペア」節）。省略時は今までどおり全ペアを返す。
    if (parsed.data.pair !== undefined && !isKnownPair(parsed.data.pair)) {
      return err(ErrorCode.INVALID_ASSET);
    }
    await fastify.store.tick();
    const filtered = filterActiveOrders(activeOrders(fastify.store.state()), parsed.data);
    return ok({ orders: filtered.map(formatOrder) });
  });
};
