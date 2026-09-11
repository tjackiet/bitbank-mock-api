import type { FastifyPluginAsync } from "fastify";
import { pairAssets } from "../engine/state.ts";
import { placeOrder, TransitionError } from "../engine/transitions.ts";
import { CreateOrderRequestSchema } from "../schemas/requests.ts";
import { err, ErrorCode, ok } from "./envelope.ts";
import { formatOrder } from "./format.ts";

function mapPlaceError(error: string) {
  switch (error) {
    case TransitionError.INSUFFICIENT_FUNDS:
      return err(ErrorCode.INSUFFICIENT_FUNDS);
    case TransitionError.INVALID_PRICE:
    case TransitionError.LIMIT_PRICE_REQUIRED:
      return err(ErrorCode.INVALID_PRICE);
    case TransitionError.INVALID_AMOUNT:
      return err(ErrorCode.INVALID_AMOUNT);
    case TransitionError.INVALID_PAIR:
      return err(ErrorCode.INVALID_PAIR);
    case TransitionError.MARKET_PRICE_REQUIRED:
      return err(ErrorCode.INTERNAL);
    default:
      return err(ErrorCode.INTERNAL);
  }
}

export const createOrderRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/v1/user/spot/order", async (request, reply) => {
    const parsed = CreateOrderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return err(ErrorCode.INVALID_PARAMETER);
    }
    const { pair, side, type, amount, price } = parsed.data;
    const store = fastify.store;
    await store.tick();
    if (!pairAssets(pair)) return err(ErrorCode.INVALID_PAIR);

    const now = new Date().toISOString();
    if (type === "market") {
      const fillPrice = await store.getLatestPrice(pair);
      if (fillPrice === null) return err(ErrorCode.INTERNAL);
      const r = placeOrder(store.state(), { pair, side, type, amount }, now, fillPrice, store.feeRate);
      if (!r.success) return mapPlaceError(r.error);
      store.replace(r.data.state);
      await store.persist();
      return ok(formatOrder(r.data.order));
    }

    const r = placeOrder(
      store.state(),
      { pair, side, type, amount, price },
      now,
      undefined,
      store.feeRate,
    );
    if (!r.success) return mapPlaceError(r.error);
    store.replace(r.data.state);
    await store.persist();
    return ok(formatOrder(r.data.order));
  });
};
