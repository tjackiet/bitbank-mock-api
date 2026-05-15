import type { FastifyPluginAsync } from "fastify";
import { availableOf, type OpenOrder, type PaperHistoryEntry } from "../engine/state.ts";
import { CreateOrderRequestSchema } from "../schemas/requests.ts";
import { err, ErrorCode, ok } from "./envelope.ts";
import { formatHistoryAsOrder, formatOpenOrder } from "./format.ts";

export const createOrderRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/v1/user/spot/order", async (request, reply) => {
    const parsed = CreateOrderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return err(ErrorCode.INVALID_PARAMETER);
    }
    const { pair, side, type, amount, price } = parsed.data;
    const [base, quote] = pair.split("_");
    if (!base || !quote) return err(ErrorCode.INVALID_PAIR);

    const store = fastify.store;
    await store.tick();

    if (type === "limit") {
      if (price === undefined || !Number.isFinite(price) || price <= 0) {
        return err(ErrorCode.INVALID_PRICE);
      }
      const feeRate = store.feeRate;
      const state = store.state();
      if (side === "buy") {
        const need = price * amount * (1 + feeRate);
        if (availableOf(state, quote, feeRate) < need) return err(ErrorCode.INSUFFICIENT_FUNDS);
      } else {
        if (availableOf(state, base, feeRate) < amount) return err(ErrorCode.INSUFFICIENT_FUNDS);
      }
      const order: OpenOrder = {
        id: store.nextOrderId(),
        pair,
        side,
        type: "limit",
        price,
        amount,
        createdAt: new Date().toISOString(),
      };
      store.replace({ ...state, openOrders: [...state.openOrders, order] });
      await store.persist();
      return ok(formatOpenOrder(order));
    }

    // market
    const fillPrice = await store.getLatestPrice(pair);
    if (fillPrice === null) return err(ErrorCode.INTERNAL);
    const feeRate = store.feeRate;
    const notional = fillPrice * amount;
    const feeJpy = notional * feeRate;
    const state = store.state();
    const balances = { ...state.balances };
    if (side === "buy") {
      if (availableOf(state, quote, feeRate) < notional + feeJpy) {
        return err(ErrorCode.INSUFFICIENT_FUNDS);
      }
      balances[quote] = (balances[quote] ?? 0) - (notional + feeJpy);
      balances[base] = (balances[base] ?? 0) + amount;
    } else {
      if (availableOf(state, base, feeRate) < amount) return err(ErrorCode.INSUFFICIENT_FUNDS);
      balances[base] = (balances[base] ?? 0) - amount;
      balances[quote] = (balances[quote] ?? 0) + (notional - feeJpy);
    }
    const filledAt = new Date().toISOString();
    const entry: PaperHistoryEntry = {
      id: store.nextOrderId(),
      pair,
      side,
      type: "market",
      amount,
      fillPrice,
      feeJpy,
      filledAt,
    };
    store.replace({
      ...state,
      balances,
      history: [...state.history, entry],
      updatedAt: filledAt,
    });
    await store.persist();
    return ok(formatHistoryAsOrder(entry));
  });
};
