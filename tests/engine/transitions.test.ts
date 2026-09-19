import { describe, expect, it } from "vitest";
import { invariantViolations } from "../../src/engine/invariants.ts";
import { remainingOf } from "../../src/engine/state.ts";
import {
  cancelOrder,
  fillOrder,
  placeOrder,
  rejectOrder,
  TransitionError,
} from "../../src/engine/transitions.ts";
import { buildOrder, buildState } from "./helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:01:00.000Z";

describe("placeOrder", () => {
  it("places a limit order as UNFILLED without a trade", () => {
    const r = placeOrder(
      buildState(),
      { pair: "btc_jpy", side: "buy", type: "limit", amount: 0.001, price: 5_000_000 },
      NOW,
      undefined,
      0,
    );
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.id).toBe("1");
    expect(r.data.order.status).toBe("UNFILLED");
    expect(r.data.trade).toBeUndefined();
    expect(r.data.state.nextOrderSeq).toBe(2);
    expect(r.data.state.orders).toHaveLength(1);
    expect(invariantViolations(r.data.state, 0)).toEqual([]);
  });

  it("fills a market order immediately", () => {
    const r = placeOrder(
      buildState({ balances: { jpy: 10_000_000 } }),
      { pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 },
      NOW,
      5_000_000,
      0,
    );
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("FULLY_FILLED");
    expect(r.data.trade?.price).toBe(5_000_000);
    expect(r.data.trade?.tradeId).toBe("1");
    expect(r.data.state.trades).toHaveLength(1);
    expect(r.data.state.balances.btc).toBeCloseTo(0.001, 10);
    expect(invariantViolations(r.data.state, 0)).toEqual([]);
  });

  it("rejects market without a price", () => {
    const r = placeOrder(
      buildState(),
      { pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 },
      NOW,
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(TransitionError.MARKET_PRICE_REQUIRED);
  });

  it("rejects a pair whose base and quote are the same", () => {
    const r = placeOrder(
      buildState(),
      { pair: "jpy_jpy", side: "buy", type: "limit", amount: 1, price: 0.5 },
      NOW,
      undefined,
      0,
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(TransitionError.INVALID_PAIR);
  });

  it("rejects insufficient funds", () => {
    const r = placeOrder(
      buildState({ balances: { jpy: 100 } }),
      { pair: "btc_jpy", side: "buy", type: "limit", amount: 0.001, price: 5_000_000 },
      NOW,
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(TransitionError.INSUFFICIENT_FUNDS);
  });

  /**
   * 非正の数量・価格を engine でも断る。
   *
   * **互換ルートからは届かない組み合わせがある。** `amount` は
   * `src/schemas/requests.ts` の `refine((n) => n > 0)` が先に落とすので、ここは
   * engine を直接呼ぶ経路（`/_control/` や将来の呼び出し元）に対する防御であり、
   * ルート側のテストでは覆えない。実際 `input.amount <= 0` を `< 0` に変えても
   * 458 件が 1 件も落ちなかった（実測）。
   *
   * 数量 0 を通すと `startAmount === 0` の注文ができ、**遷移関数を通る限り不変量は
   * 破れない**という前提（`preconditionViolations()` の `startAmount > 0`）が崩れて、
   * 書き出した state を読み戻せなくなる。
   */
  it.each([
    ["数量 0", { amount: 0 }, TransitionError.INVALID_AMOUNT],
    ["数量が負", { amount: -0.001 }, TransitionError.INVALID_AMOUNT],
    ["指値 0", { price: 0 }, TransitionError.LIMIT_PRICE_REQUIRED],
    ["指値が負", { price: -1 }, TransitionError.LIMIT_PRICE_REQUIRED],
  ])("placeOrder は %s を断り、状態を変えない", (_label, override, expected) => {
    const state = buildState({ balances: { jpy: 10_000_000 } });
    const before = JSON.stringify(state);
    const r = placeOrder(
      state,
      { pair: "btc_jpy", side: "buy", type: "limit", amount: 0.001, price: 5_000_000, ...override },
      NOW,
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(expected);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("成行の基準価格が 0 なら MARKET_PRICE_REQUIRED で断る", () => {
    // 成行は `marketPrice` が基準になる。欠落（上の「rejects market without a price」）と
    // 同じコードに寄せてある——どちらも「使える価格が無い」なので分けていない。
    const r = placeOrder(
      buildState({ balances: { jpy: 10_000_000 } }),
      { pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 },
      NOW,
      0,
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(TransitionError.MARKET_PRICE_REQUIRED);
  });
});

describe("fillOrder", () => {
  it("partial fill moves status to PARTIALLY_FILLED and keeps average", () => {
    const order = buildOrder({ startAmount: 1, price: 100 });
    const state = buildState({ balances: { jpy: 10_000 }, orders: [order] });
    const r = fillOrder(state, order.id, 100, 0.4, LATER, 0);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("PARTIALLY_FILLED");
    expect(r.data.order.executedAmount).toBeCloseTo(0.4, 10);
    expect(remainingOf(r.data.order)).toBeCloseTo(0.6, 10);
    expect(r.data.order.executedNotional / r.data.order.executedAmount).toBe(100);
    expect(invariantViolations(r.data.state, 0)).toEqual([]);
  });

  // 買いの約定は base 残高を増やす。base が `constructor` だと、state.balances に
  // そのキーが無いとき素の `balances[base] ?? 0` は Object.prototype の継承値を返し、
  // 残高が "function Object() { [native code] }1" という文字列になっていた。
  // 拒否の経路（60001）だけでなく、約定が通る経路も固定しておく。
  it("credits a numeric balance when the base asset shadows Object.prototype", () => {
    const order = buildOrder({ pair: "constructor_jpy", side: "buy", price: 100, startAmount: 1 });
    const state = buildState({ balances: { jpy: 10_000 }, orders: [order] });
    const r = fillOrder(state, order.id, 100, 1, LATER, 0);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("FULLY_FILLED");
    // 継承値を掴むと文字列連結になるので、型と値の両方を見る。
    expect(typeof r.data.state.balances.constructor).toBe("number");
    expect(r.data.state.balances.constructor).toBeCloseTo(1, 10);
    expect(r.data.state.balances.jpy).toBeCloseTo(10_000 - 100, 10);
    expect(invariantViolations(r.data.state, 0)).toEqual([]);
  });

  it("completing remaining amount yields FULLY_FILLED", () => {
    const order = buildOrder({
      startAmount: 1,
      price: 100,
      executedAmount: 0.4,
      executedNotional: 40,
      status: "PARTIALLY_FILLED",
    });
    const state = buildState({
      balances: { jpy: 10_000, btc: 0.4 },
      orders: [order],
      nextTradeSeq: 2,
      trades: [
        {
          tradeId: "1",
          orderId: order.id,
          pair: "btc_jpy",
          side: "buy",
          type: "limit",
          amount: 0.4,
          price: 100,
          feeQuote: 0,
          makerTaker: "maker",
          executedAt: NOW,
        },
      ],
    });
    const r = fillOrder(state, order.id, 100, 0.6, LATER, 0);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("FULLY_FILLED");
    expect(r.data.trade?.tradeId).toBe("2");
    expect(invariantViolations(r.data.state, 0)).toEqual([]);
  });

  it("rejects a worse-than-limit fill price", () => {
    const buy = buildOrder({ side: "buy", price: 100, startAmount: 1 });
    const buyR = fillOrder(buildState({ orders: [buy] }), buy.id, 101, 1, LATER, 0);
    expect(buyR.success).toBe(false);

    const sell = buildOrder({ id: "2", side: "sell", price: 100, startAmount: 1 });
    const sellR = fillOrder(buildState({ orders: [sell] }), sell.id, 99, 1, LATER, 0);
    expect(sellR.success).toBe(false);
  });

  it("treats a one-ulp overshoot of remaining as a full fill", () => {
    const order = buildOrder({
      startAmount: 0.3,
      price: 100,
      executedAmount: 0,
      executedNotional: 0,
    });
    let state = buildState({ balances: { jpy: 10_000 }, orders: [order] });
    const first = fillOrder(state, order.id, 100, 0.1, NOW, 0);
    expect(first.success).toBe(true);
    if (!first.success) throw new Error("unreachable");
    state = first.data.state;
    const second = fillOrder(state, order.id, 100, 0.1, NOW, 0);
    expect(second.success).toBe(true);
    if (!second.success) throw new Error("unreachable");
    state = second.data.state;
    const rem = remainingOf(state.orders[0]!);
    const r = fillOrder(state, order.id, 100, rem + 1e-16, LATER, 0);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("FULLY_FILLED");
    expect(r.data.order.executedAmount).toBeCloseTo(0.3, 12);
    expect(invariantViolations(r.data.state, 0)).toEqual([]);
  });

  it("rejects amount above remaining and does not mutate", () => {
    const order = buildOrder({ startAmount: 1, price: 100 });
    const state = buildState({ orders: [order] });
    const r = fillOrder(state, order.id, 100, 1.1, LATER, 0);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(TransitionError.INVALID_AMOUNT);
    expect(state.orders[0]?.status).toBe("UNFILLED");
    expect(state.trades).toHaveLength(0);
  });

  it("rejects fill on a terminal order", () => {
    const order = buildOrder({
      status: "FULLY_FILLED",
      startAmount: 1,
      executedAmount: 1,
      executedNotional: 100,
    });
    const snapshot = structuredClone(order);
    const r = fillOrder(buildState({ orders: [order] }), order.id, 100, 1, LATER, 0);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(TransitionError.ORDER_NOT_ACTIVE);
    expect(order).toEqual(snapshot);
  });
});

describe("cancelOrder / rejectOrder", () => {
  it("cancels UNFILLED → CANCELED_UNFILLED", () => {
    const order = buildOrder();
    const r = cancelOrder(buildState({ orders: [order] }), order.id, LATER);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("CANCELED_UNFILLED");
    expect(r.data.order.canceledAt).toBe(LATER);
    expect(invariantViolations(r.data.state)).toEqual([]);
  });

  it("cancels PARTIALLY_FILLED → CANCELED_PARTIALLY_FILLED and keeps executed", () => {
    const order = buildOrder({
      status: "PARTIALLY_FILLED",
      startAmount: 1,
      executedAmount: 0.3,
      executedNotional: 30,
    });
    const state = buildState({
      orders: [order],
      trades: [
        {
          tradeId: "1",
          orderId: order.id,
          pair: "btc_jpy",
          side: "buy",
          type: "limit",
          amount: 0.3,
          price: 100,
          feeQuote: 0,
          makerTaker: "maker",
          executedAt: NOW,
        },
      ],
    });
    const r = cancelOrder(state, order.id, LATER);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("CANCELED_PARTIALLY_FILLED");
    expect(r.data.order.executedAmount).toBe(0.3);
    expect(invariantViolations(r.data.state)).toEqual([]);
  });

  it("refuses to transition a terminal order", () => {
    const order = buildOrder({
      status: "CANCELED_UNFILLED",
      canceledAt: NOW,
    });
    const snapshot = structuredClone(order);
    expect(cancelOrder(buildState({ orders: [order] }), order.id, LATER).success).toBe(false);
    expect(rejectOrder(buildState({ orders: [order] }), order.id, LATER).success).toBe(false);
    expect(order).toEqual(snapshot);
  });

  it("refuses rejectOrder on a partially filled order", () => {
    const order = buildOrder({
      status: "PARTIALLY_FILLED",
      startAmount: 1,
      executedAmount: 0.3,
      executedNotional: 30,
    });
    const snapshot = structuredClone(order);
    const r = rejectOrder(buildState({ orders: [order] }), order.id, LATER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toBe(TransitionError.ORDER_NOT_ACTIVE);
    expect(order).toEqual(snapshot);
  });

  it("rejectOrder sets REJECTED", () => {
    const order = buildOrder();
    const r = rejectOrder(buildState({ orders: [order] }), order.id, LATER);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error("unreachable");
    expect(r.data.order.status).toBe("REJECTED");
    expect(invariantViolations(r.data.state)).toEqual([]);
  });
});

/**
 * 採番は `String(seq)` を配って `seq + 1` へ進めるので、`seq` が安全整数を外れると
 * `+ 1` が飽和して同じ id を配り続ける。読み込み時の検査（`preconditionViolations()`）は
 * 読み込んだ時点の `seq` しか見られず、飽和は実行中に起きるので防げない。配る側で断る。
 */
describe("採番の飽和", () => {
  const MAX = Number.MAX_SAFE_INTEGER;

  function idsFrom(seq: number, count: number): string[] {
    let state = buildState({ balances: { jpy: 1e12, btc: 1e6 }, nextOrderSeq: seq });
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const r = placeOrder(
        state,
        { pair: "btc_jpy", side: "sell", type: "limit", amount: 0.001, price: 6_000_000 },
        NOW,
        undefined,
        0,
      );
      if (!r.success) {
        ids.push(`FAIL:${r.error}`);
        break;
      }
      state = r.data.state;
      ids.push(r.data.order.id);
    }
    return ids;
  }

  // 境界のどこから始めても、配る id は必ず直前より大きく、重複しない。
  // `MAX_SAFE_INTEGER` を配り切った次で断る。
  it("飽和した採番からは発注できず、同じ id を 2 回配らない", () => {
    expect(idsFrom(MAX, 4)).toEqual(["9007199254740991", "FAIL:ORDER_SEQ_EXHAUSTED"]);
    expect(idsFrom(MAX - 1, 4)).toEqual([
      "9007199254740990",
      "9007199254740991",
      "FAIL:ORDER_SEQ_EXHAUSTED",
    ]);
    // 読み込み時の検査が弾く値（安全整数の外）からは 1 件も配らない。
    expect(idsFrom(MAX + 1, 2)).toEqual(["FAIL:ORDER_SEQ_EXHAUSTED"]);
  });

  it("成行でも飽和した採番からは注文を作らない", () => {
    const state = buildState({ nextOrderSeq: MAX + 1 });
    const r = placeOrder(
      state,
      { pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 },
      NOW,
      5_000_000,
      0,
    );
    expect(r.success).toBe(false);
    if (r.success) throw new Error("unreachable");
    expect(r.error).toBe(TransitionError.ORDER_SEQ_EXHAUSTED);
  });

  it("trade の採番が飽和していれば約定させない（状態は変えない）", () => {
    const state = buildState({
      orders: [buildOrder({ side: "sell" })],
      balances: { jpy: 10_000_000, btc: 1 },
      nextTradeSeq: MAX + 1,
    });
    const snapshot = structuredClone(state);
    const r = fillOrder(state, "1", 5_000_000, 0.001, LATER, 0);
    expect(r.success).toBe(false);
    if (r.success) throw new Error("unreachable");
    expect(r.error).toBe(TransitionError.TRADE_SEQ_EXHAUSTED);
    expect(state).toEqual(snapshot);
  });
});
