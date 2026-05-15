import type { OpenOrder, PaperHistoryEntry, PaperState } from "../engine/state.ts";
import { computeLocked, DEFAULT_TAKER_FEE_RATE } from "../engine/state.ts";

export type OrderStatus =
  | "UNFILLED"
  | "PARTIALLY_FILLED"
  | "FULLY_FILLED"
  | "CANCELED_UNFILLED"
  | "CANCELED_PARTIALLY_FILLED";

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

export function formatOpenOrder(o: OpenOrder): OrderShape {
  return {
    order_id: toIdOut(o.id),
    pair: o.pair,
    side: o.side,
    type: o.type,
    start_amount: String(o.amount),
    remaining_amount: String(o.amount),
    executed_amount: "0",
    price: String(o.price),
    average_price: "0",
    ordered_at: Date.parse(o.createdAt),
    status: "UNFILLED",
  };
}

export function formatHistoryAsOrder(h: PaperHistoryEntry): OrderShape {
  return {
    order_id: toIdOut(h.id),
    pair: h.pair,
    side: h.side,
    type: h.type,
    start_amount: String(h.amount),
    remaining_amount: "0",
    executed_amount: String(h.amount),
    price: String(h.fillPrice),
    average_price: String(h.fillPrice),
    ordered_at: Date.parse(h.filledAt),
    status: "FULLY_FILLED",
  };
}

export function formatCanceledOrder(o: OpenOrder): OrderShape {
  return {
    ...formatOpenOrder(o),
    status: "CANCELED_UNFILLED",
  };
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

export function formatTrade(h: PaperHistoryEntry): TradeShape {
  return {
    trade_id: toIdOut(h.id),
    order_id: toIdOut(h.id),
    pair: h.pair,
    side: h.side,
    type: h.type,
    amount: String(h.amount),
    price: String(h.fillPrice),
    maker_taker: h.type === "limit" ? "maker" : "taker",
    fee_amount_base: "0",
    fee_amount_quote: String(h.feeJpy),
    executed_at: Date.parse(h.filledAt),
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
