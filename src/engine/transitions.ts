import {
  amountOf,
  availableOf,
  DEFAULT_TAKER_FEE_RATE,
  isActive,
  isTerminal,
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
  ORDER_SEQ_EXHAUSTED: "ORDER_SEQ_EXHAUSTED",
  TRADE_SEQ_EXHAUSTED: "TRADE_SEQ_EXHAUSTED",
} as const;

/**
 * 採番がもう一意な id を配れないか。`String(seq)` を配って `seq + 1` へ進める採番は、
 * `seq` が安全整数を外れた時点で `+ 1` が飽和し、以後は同じ id を配り続ける。
 *
 * 読み込み時の検査（`preconditionViolations()`）だけではこれを防げない。検査が見るのは
 * 読み込んだ時点の `seq` で、飽和は実行中の `+ 1` で起きるからである。境界をどこに引いても
 * 「あと数件で飽和する `seq`」は検査を通ってしまい、その数件を配った後に重複が出る
 * （`Number.MAX_SAFE_INTEGER` を弾いても `MAX_SAFE_INTEGER - 1` が同じ道を辿る）。
 * だから配る側で止める。ここで断る限り、配った id は必ず直前より大きく、重複しない。
 *
 * 本モックの採番は 1 から 1 ずつ進むので、通常の利用でここに到達することはない
 * （`2^53` 件の発注が要る）。届くのは state ファイルに手で大きな採番を書いた場合と、
 * 巨大な id を持つ v1 / v2 を移行した場合だけである（docs/fidelity.md の「不変量の前提」）。
 */
function canIssue(seq: number): boolean {
  return Number.isSafeInteger(seq);
}

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
  // 飽和した採番からは注文を作らない（同じ id を 2 回配らないため）。指値・成行の
  // どちらも `String(state.nextOrderSeq)` を配るので、分岐の手前で 1 度だけ見る。
  if (!canIssue(state.nextOrderSeq)) return fail(TransitionError.ORDER_SEQ_EXHAUSTED);

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

/**
 * active な注文へ約定を 1 件適用し、注文・trade・残高を同じ返り値で更新する。
 *
 * 部分適用が起きないので不変量 5（trade の合計 == `executedAmount`）を保てる。
 * 残量との差が `AMOUNT_EPS` 以下なら全約定として残量ちょうどに丸め、
 * `FULLY_FILLED` にする（不変量 1・3）。指値では order price より不利な価格を
 * `INVALID_PRICE` で断るので、発注時に拘束した分を超えて使わない（不変量 6）。
 *
 * 終端・不在の注文、非正や残量超過の量、不正なペアは状態を変えずに失敗を返す。
 */
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
  // trade も同じ採番で id を配る。飽和していれば約定させない（状態は変えない）。
  if (!canIssue(state.nextTradeSeq)) return fail(TransitionError.TRADE_SEQ_EXHAUSTED);
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
    balances[quote] = amountOf(balances, quote) - (notional + feeQuote);
    balances[base] = amountOf(balances, base) + fillAmount;
  } else {
    balances[base] = amountOf(balances, base) - fillAmount;
    balances[quote] = amountOf(balances, quote) + (notional - feeQuote);
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
  return ok({ state: replaceOrder(state, order), order });
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
  return ok({ state: replaceOrder(state, order), order });
}
