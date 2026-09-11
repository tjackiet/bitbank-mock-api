import {
  availableOf,
  DEFAULT_TAKER_FEE_RATE,
  isActive,
  isTerminal,
  lockedAssetOf,
  pairAssets,
  remainingOf,
  type OrderRecord,
  type PaperState,
  type TradeRecord,
} from "./state.ts";

const AMOUNT_EPS = 1e-12;
import type { Result } from "./types.ts";

export const TransitionError = {
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  ORDER_NOT_ACTIVE: "ORDER_NOT_ACTIVE",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_PRICE: "INVALID_PRICE",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  MARKET_PRICE_REQUIRED: "MARKET_PRICE_REQUIRED",
  INVALID_PAIR: "INVALID_PAIR",
  LIMIT_PRICE_REQUIRED: "LIMIT_PRICE_REQUIRED",
} as const;

export type PlaceOrderInput = {
  pair: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  amount: number;
  price?: number;
};

export type TransitionOk = {
  state: PaperState;
  order: OrderRecord;
  trade?: TradeRecord;
  touchedAssets: string[];
};

function ok(data: TransitionOk): Result<TransitionOk> {
  return { success: true, data };
}

function fail(error: string): Result<TransitionOk> {
  return { success: false, error };
}

function replaceOrder(state: PaperState, order: OrderRecord): PaperState {
  return {
    ...state,
    orders: state.orders.map((o) => (o.id === order.id ? order : o)),
    updatedAt: order.updatedAt,
  };
}

export function placeOrder(
  state: PaperState,
  input: PlaceOrderInput,
  now: string,
  marketPrice?: number,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): Result<TransitionOk> {
  const assets = pairAssets(input.pair);
  if (!assets) return fail(TransitionError.INVALID_PAIR);
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return fail(TransitionError.INVALID_AMOUNT);
  }

  const [base, quote] = assets;
  if (input.type === "limit") {
    if (input.price === undefined || !Number.isFinite(input.price) || input.price <= 0) {
      return fail(TransitionError.LIMIT_PRICE_REQUIRED);
    }
    if (input.side === "buy") {
      const need = input.price * input.amount * (1 + feeRate);
      if (availableOf(state, quote, feeRate) < need) return fail(TransitionError.INSUFFICIENT_FUNDS);
    } else if (availableOf(state, base, feeRate) < input.amount) {
      return fail(TransitionError.INSUFFICIENT_FUNDS);
    }
    const order: OrderRecord = {
      id: String(state.nextOrderSeq),
      pair: input.pair,
      side: input.side,
      type: "limit",
      price: input.price,
      startAmount: input.amount,
      executedAmount: 0,
      executedNotional: 0,
      status: "UNFILLED",
      orderedAt: now,
      canceledAt: null,
      updatedAt: now,
    };
    return ok({
      state: {
        ...state,
        orders: [...state.orders, order],
        nextOrderSeq: state.nextOrderSeq + 1,
        updatedAt: now,
      },
      order,
      touchedAssets: [input.side === "buy" ? quote : base],
    });
  }

  if (marketPrice === undefined || !Number.isFinite(marketPrice) || marketPrice <= 0) {
    return fail(TransitionError.MARKET_PRICE_REQUIRED);
  }
  if (input.side === "buy") {
    const need = marketPrice * input.amount * (1 + feeRate);
    if (availableOf(state, quote, feeRate) < need) return fail(TransitionError.INSUFFICIENT_FUNDS);
  } else if (availableOf(state, base, feeRate) < input.amount) {
    return fail(TransitionError.INSUFFICIENT_FUNDS);
  }

  const seed: OrderRecord = {
    id: String(state.nextOrderSeq),
    pair: input.pair,
    side: input.side,
    type: "market",
    price: null,
    startAmount: input.amount,
    executedAmount: 0,
    executedNotional: 0,
    status: "UNFILLED",
    orderedAt: now,
    canceledAt: null,
    updatedAt: now,
  };
  const placed: PaperState = {
    ...state,
    orders: [...state.orders, seed],
    nextOrderSeq: state.nextOrderSeq + 1,
    updatedAt: now,
  };
  return fillOrder(placed, seed.id, marketPrice, input.amount, now, feeRate);
}

export function fillOrder(
  state: PaperState,
  orderId: string,
  price: number,
  amount: number,
  at: string,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): Result<TransitionOk> {
  const current = state.orders.find((o) => o.id === orderId);
  if (!current) return fail(TransitionError.ORDER_NOT_FOUND);
  if (!isActive(current)) return fail(TransitionError.ORDER_NOT_ACTIVE);
  const remaining = remainingOf(current);
  if (!Number.isFinite(amount) || amount <= 0 || amount - remaining > AMOUNT_EPS) {
    return fail(TransitionError.INVALID_AMOUNT);
  }
  const fully = remaining - amount <= AMOUNT_EPS;
  const fillAmount = fully ? remaining : amount;
  if (!Number.isFinite(price) || price <= 0) return fail(TransitionError.INVALID_PRICE);
  if (current.type === "limit" && current.price != null) {
    const worse =
      current.side === "buy" ? price > current.price : price < current.price;
    if (worse) return fail(TransitionError.INVALID_PRICE);
  }

  const assets = pairAssets(current.pair);
  if (!assets) return fail(TransitionError.INVALID_PAIR);
  const [base, quote] = assets;
  const notional = price * fillAmount;
  const feeQuote = notional * feeRate;
  const balances = { ...state.balances };
  if (current.side === "buy") {
    balances[quote] = (balances[quote] ?? 0) - (notional + feeQuote);
    balances[base] = (balances[base] ?? 0) + fillAmount;
  } else {
    balances[base] = (balances[base] ?? 0) - fillAmount;
    balances[quote] = (balances[quote] ?? 0) + (notional - feeQuote);
  }

  const executedAmount = fully ? current.startAmount : current.executedAmount + fillAmount;
  const executedNotional = current.executedNotional + notional;
  const order: OrderRecord = {
    ...current,
    executedAmount,
    executedNotional,
    status: fully ? "FULLY_FILLED" : "PARTIALLY_FILLED",
    updatedAt: at,
  };
  const trade: TradeRecord = {
    tradeId: String(state.nextTradeSeq),
    orderId: current.id,
    pair: current.pair,
    side: current.side,
    type: current.type,
    amount: fillAmount,
    price,
    feeQuote,
    makerTaker: current.type === "limit" ? "maker" : "taker",
    executedAt: at,
  };

  return ok({
    state: {
      ...replaceOrder(state, order),
      balances,
      trades: [...state.trades, trade],
      nextTradeSeq: state.nextTradeSeq + 1,
      updatedAt: at,
    },
    order,
    trade,
    touchedAssets: [base, quote],
  });
}

export function cancelOrder(
  state: PaperState,
  orderId: string,
  at: string,
): Result<TransitionOk> {
  const current = state.orders.find((o) => o.id === orderId);
  if (!current) return fail(TransitionError.ORDER_NOT_FOUND);
  if (isTerminal(current)) return fail(TransitionError.ORDER_NOT_ACTIVE);
  if (!isActive(current)) return fail(TransitionError.ORDER_NOT_ACTIVE);

  const order: OrderRecord = {
    ...current,
    status: current.status === "PARTIALLY_FILLED" ? "CANCELED_PARTIALLY_FILLED" : "CANCELED_UNFILLED",
    canceledAt: at,
    updatedAt: at,
  };
  const locked = lockedAssetOf(current.side, current.pair);
  return ok({
    state: replaceOrder(state, order),
    order,
    touchedAssets: locked ? [locked] : [],
  });
}

export function rejectOrder(
  state: PaperState,
  orderId: string,
  at: string,
): Result<TransitionOk> {
  const current = state.orders.find((o) => o.id === orderId);
  if (!current) return fail(TransitionError.ORDER_NOT_FOUND);
  if (current.status !== "UNFILLED" && current.status !== "INACTIVE") {
    return fail(TransitionError.ORDER_NOT_ACTIVE);
  }

  const order: OrderRecord = {
    ...current,
    status: "REJECTED",
    updatedAt: at,
  };
  const locked = lockedAssetOf(current.side, current.pair);
  return ok({
    state: replaceOrder(state, order),
    order,
    touchedAssets: locked ? [locked] : [],
  });
}
