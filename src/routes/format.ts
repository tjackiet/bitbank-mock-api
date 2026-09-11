import {
  averagePriceOf,
  computeLocked,
  DEFAULT_TAKER_FEE_RATE,
  remainingOf,
  type OrderRecord,
  type OrderStatus,
  type PaperState,
  type TradeRecord,
} from "../engine/state.ts";

const KNOWN_ASSETS = ["jpy", "btc", "eth", "xrp", "ltc", "bcc", "mona", "xlm", "qtum", "bat"];

type OrderShape = {
  order_id: number | string;
  pair: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  start_amount: string;
  remaining_amount: string;
  executed_amount: string;
  price: string;
  average_price: string;
  ordered_at: number;
  status: OrderStatus;
};

function displayPrice(o: OrderRecord): number {
  if (o.price != null) return o.price;
  return averagePriceOf(o);
}

export function formatOrder(o: OrderRecord): OrderShape {
  return {
    order_id: toIdOut(o.id),
    pair: o.pair,
    side: o.side,
    type: o.type,
    start_amount: String(o.startAmount),
    remaining_amount: String(remainingOf(o)),
    executed_amount: String(o.executedAmount),
    price: String(displayPrice(o)),
    average_price: String(averagePriceOf(o)),
    ordered_at: Date.parse(o.orderedAt),
    status: o.status,
  };
}

export function formatOpenOrder(o: OrderRecord): OrderShape {
  return formatOrder(o);
}

export function formatHistoryAsOrder(o: OrderRecord): OrderShape {
  return formatOrder(o);
}

export function formatCanceledOrder(o: OrderRecord): OrderShape {
  return formatOrder(o);
}

export type TradeShape = {
  trade_id: number | string;
  order_id: number | string;
  pair: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: string;
  price: string;
  maker_taker: "maker" | "taker";
  fee_amount_base: string;
  fee_amount_quote: string;
  executed_at: number;
};

export function formatTrade(t: TradeRecord): TradeShape {
  return {
    trade_id: toIdOut(t.tradeId),
    order_id: toIdOut(t.orderId),
    pair: t.pair,
    side: t.side,
    type: t.type,
    amount: String(t.amount),
    price: String(t.price),
    maker_taker: t.makerTaker,
    fee_amount_base: "0",
    fee_amount_quote: String(t.feeQuote),
    executed_at: Date.parse(t.executedAt),
  };
}

export type AssetShape = {
  asset: string;
  free_amount: string;
  amount_precision: number;
  onhand_amount: string;
  locked_amount: string;
  withdrawal_fee: string;
  stop_deposit: boolean;
  stop_withdrawal: boolean;
};

export function formatAssets(state: PaperState, feeRate: number = DEFAULT_TAKER_FEE_RATE): {
  assets: AssetShape[];
} {
  const locked = computeLocked(state, feeRate);
  const assetSet = new Set<string>([
    ...KNOWN_ASSETS,
    ...Object.keys(state.balances),
    ...Object.keys(locked),
  ]);
  const assets: AssetShape[] = [];
  for (const a of assetSet) {
    const total = state.balances[a] ?? 0;
    const l = locked[a] ?? 0;
    const free = total - l;
    assets.push({
      asset: a,
      free_amount: String(free),
      amount_precision: a === "jpy" ? 4 : 8,
      onhand_amount: String(total),
      locked_amount: String(l),
      withdrawal_fee: "0",
      stop_deposit: false,
      stop_withdrawal: false,
    });
  }
  return { assets };
}

function toIdOut(id: string): number | string {
  const n = Number(id);
  return Number.isFinite(n) && String(n) === id ? n : id;
}
