import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { invariantViolations, preconditionViolations } from "../../src/engine/invariants.ts";
import { activeOrders, isTerminal, remainingOf, type PaperState } from "../../src/engine/state.ts";
import { cancelOrder, fillOrder, placeOrder, rejectOrder } from "../../src/engine/transitions.ts";
import { buildOrder, buildState, buildTrade } from "./helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * 発注する数量。小さい側（`0.001` 付近）と、不変量 5 の境界を跨ぐ大きい側（`8192` 以上）の
 * 両方を出す。
 *
 * 旧範囲は `0.001`〜`0.006` で、`fillOrder` の全約定クランプが作る 1 ulp のずれが不変量 5 の
 * 許容差に埋もれてしまい、この操作列では違反を再現できなかった（`8192` 以上で 1 ulp が
 * `1e-12` を超える）。桁 4 の格子へ丸めるのは互換ルートの `fitsDigits` と揃えるため。
 */
function randomAmount(seed: number, steps: number): number {
  const n = Math.abs(seed) % steps;
  const base = Math.abs(seed) % 3 === 0 ? 8192.0011 : 0.001;
  return Math.round((base + n / 10000) * 10000) / 10000;
}

function applyRandomOp(state: PaperState, kind: number, a: number, b: number): PaperState {
  const at = NOW;
  const feeRate = 0;
  const k = Math.abs(kind) % 5;
  if (k === 0) {
    const amount = randomAmount(a, 50);
    const price = 1000 + (b % 200);
    const r = placeOrder(
      state,
      { pair: "btc_jpy", side: "buy", type: "limit", amount, price },
      at,
      undefined,
      feeRate,
    );
    return r.success ? r.data.state : state;
  }
  if (k === 1) {
    const amount = randomAmount(a, 20);
    const price = 1000 + (b % 200);
    const r = placeOrder(
      state,
      { pair: "btc_jpy", side: "sell", type: "limit", amount, price },
      at,
      undefined,
      feeRate,
    );
    return r.success ? r.data.state : state;
  }
  const open = activeOrders(state);
  if (open.length === 0) return state;
  const target = open[Math.abs(a) % open.length];
  if (!target) return state;
  if (k === 2) {
    // 合計と `executedAmount` がずれる唯一の箇所は `fillOrder` の全約定クランプで、
    // 踏むのは「部分約定のあとに残量ちょうどを約定させる」経路だけ。毎回 open から
    // 一様に選ぶと open が増えるぶん同じ注文を続けて引けず、40 操作では滅多に届かない。
    // `kind` の別の桁（`k` が使うのは 5 で割った余りだけ）で、半分は部分約定済みから選ぶ。
    const partial = open.filter((o) => o.status === "PARTIALLY_FILLED");
    const pool = Math.abs(kind) % 10 === 7 && partial.length > 0 ? partial : open;
    const picked = pool[Math.abs(a) % pool.length];
    if (!picked) return state;
    const rem = remainingOf(picked);
    const frac = 0.25 + (Math.abs(b) % 4) * 0.25;
    const amount = Math.round(rem * frac * 10000) / 10000;
    const px = picked.price ?? 1000;
    const r = fillOrder(state, picked.id, px, amount > 0 ? Math.min(amount, rem) : rem, at, feeRate);
    return r.success ? r.data.state : state;
  }
  if (k === 3) {
    const r = cancelOrder(state, target.id, at);
    return r.success ? r.data.state : state;
  }
  const r = rejectOrder(state, target.id, at);
  return r.success ? r.data.state : state;
}

/**
 * `8208.0011` の売り指値へ `16.0009` を約定させ、残量を全部約定させた状態。
 * `fillOrder` の全約定クランプで trade の合計と `executedAmount` が 1 ulp ずれる。
 * docs/fidelity.md の「不変量 5 と `fillOrder` のクランプ」に載る再現手順そのもの。
 */
function largeFilledState(): PaperState {
  let state = buildState({ balances: { jpy: 1_000_000, xrp: 100_000 } });
  const placed = placeOrder(
    state,
    { pair: "xrp_jpy", side: "sell", type: "limit", amount: 8208.0011, price: 50 },
    NOW,
    undefined,
    0,
  );
  if (!placed.success) throw new Error(placed.error);
  state = placed.data.state;
  const partial = fillOrder(state, "1", 50, 16.0009, NOW, 0);
  if (!partial.success) throw new Error(partial.error);
  state = partial.data.state;
  const rest = fillOrder(state, "1", 50, remainingOf(partial.data.order), NOW, 0);
  if (!rest.success) throw new Error(rest.error);
  return rest.data.state;
}

describe("invariants", () => {
  it("hold on a fresh state", () => {
    expect(invariantViolations(buildState({ balances: { jpy: 10_000_000, btc: 1 } }), 0)).toEqual([]);
  });

  it("flags canceled statuses that do not match executed amount", () => {
    const unfilled = buildOrder({
      status: "CANCELED_UNFILLED",
      startAmount: 1,
      executedAmount: 0.1,
      executedNotional: 500_000,
    });
    const unfilledState = buildState({
      orders: [unfilled],
      trades: [buildTrade({ orderId: unfilled.id, amount: 0.1, price: 5_000_000, feeQuote: 0 })],
    });
    expect(invariantViolations(unfilledState).some((v) => v.includes("CANCELED_UNFILLED"))).toBe(true);
    const partial = buildOrder({
      status: "CANCELED_PARTIALLY_FILLED",
      executedAmount: 0,
      executedNotional: 0,
    });
    expect(
      invariantViolations(buildState({ orders: [partial] })).some((v) =>
        v.includes("CANCELED_PARTIALLY_FILLED"),
      ),
    ).toBe(true);
  });

  it("flags trades without an order", () => {
    const state = buildState({ trades: [buildTrade({ orderId: "missing" })] });
    expect(invariantViolations(state).some((v) => v.includes("has no order"))).toBe(true);
  });

  // 不変量 6 は資産キーで残高と拘束を引く。素の {} だと `constructor` という資産名で
  // Object.prototype の継承値を掴み、比較が NaN になって違反を取りこぼしていた。
  // 読み込み時の fail-closed がこの 1 資産だけ素通りするので、明示ケースで固定する。
  it("flags locked over balance for an asset named like an Object.prototype key", () => {
    const state = buildState({
      balances: { jpy: 1_000_000 },
      orders: [
        buildOrder({ id: "1", side: "sell", pair: "constructor_jpy", price: 100, startAmount: 999 }),
      ],
    });
    expect(invariantViolations(state, 0)).toContain("6: locked[constructor]=999 exceeds balance=0");
  });

  /**
   * `fillOrder` の全約定クランプの境界。残量ちょうどの約定で `executedAmount` を
   * `startAmount` へ揃える一方、trade には残量（`remainingOf()` の値）が入るので、
   * trade の合計は `startAmount` と最大 1 ulp ずれる。`startAmount` が `8192` 以上だと
   * その 1 ulp が `1e-12` を超えるため、遷移関数だけを通った状態が違反と判定されていた。
   *
   * 再現の値（docs/fidelity.md の同節）をそのまま固定する。ずれが実際に `1e-12` を
   * 超えていることも見て、境界を踏んでいないテストが通り続けるのを防ぐ。
   */
  it("hold for a large order filled partially then fully", () => {
    const state = largeFilledState();
    const order = state.orders[0];
    const tradeSum = state.trades.reduce((sum, t) => sum + t.amount, 0);
    expect(order?.status).toBe("FULLY_FILLED");
    expect(Math.abs(tradeSum - order!.executedAmount)).toBeGreaterThan(1e-12);
    expect(invariantViolations(state, 0)).toEqual([]);
  });

  /**
   * 同じ境界を `8192`〜`16383` の範囲で広く見る。ずれが `1e-12` を超えるのは
   * 部分約定 → 全約定の組のうち約 3.6%（実測）なので、操作列の性質より本数を多く取る。
   */
  it("hold for large partial-then-full fills across the clamp boundary", () => {
    fc.assert(
      fc.property(
        // 桁 4 の格子に載る 8192.0000〜16383.9999。
        fc.integer({ min: 81_920_000, max: 163_839_999 }),
        // 最初の約定が `startAmount` に占める割合（1/10000 単位）。
        fc.integer({ min: 1, max: 9_999 }),
        (rawAmount, rawFrac) => {
          const startAmount = rawAmount / 10_000;
          // startAmount * (rawFrac / 10000) を桁 4 の格子へ丸めた量。
          const first = Math.round(startAmount * rawFrac) / 10_000;
          if (!(first > 0) || first >= startAmount) return;
          let state = buildState({ balances: { jpy: 1_000_000, xrp: 1_000_000 } });
          const placed = placeOrder(
            state,
            { pair: "xrp_jpy", side: "sell", type: "limit", amount: startAmount, price: 50 },
            NOW,
            undefined,
            0,
          );
          if (!placed.success) throw new Error(placed.error);
          state = placed.data.state;
          const partial = fillOrder(state, "1", 50, first, NOW, 0);
          if (!partial.success) throw new Error(partial.error);
          state = partial.data.state;
          expect(invariantViolations(state, 0)).toEqual([]);
          const rest = fillOrder(state, "1", 50, remainingOf(partial.data.order), NOW, 0);
          if (!rest.success) throw new Error(rest.error);
          state = rest.data.state;
          expect(state.orders[0]?.status).toBe("FULLY_FILLED");
          expect(invariantViolations(state, 0)).toEqual([]);
        },
      ),
      { numRuns: 500 },
    );
  });

  /**
   * 許容差を大きさへ比例させても、**本当に間違っている合計は引き続き違反**になること。
   * ここが通ってしまうと不変量 5 を無効化したのと同じになる。
   */
  it("still flags a trade sum that is off by 1%", () => {
    const base = largeFilledState();
    const trades = base.trades.map((t, i) =>
      i === base.trades.length - 1 ? { ...t, amount: t.amount * 0.99 } : t,
    );
    const violations = invariantViolations({ ...base, trades }, 0);
    expect(violations.some((v) => v.startsWith("5: order 1 trades="))).toBe(true);
  });

  it("still flags a missing trade", () => {
    const base = largeFilledState();
    const violations = invariantViolations({ ...base, trades: base.trades.slice(1) }, 0);
    expect(violations.some((v) => v.startsWith("5: order 1 trades="))).toBe(true);
  });

  it("still flags a notional sum that is off by 1%", () => {
    const base = largeFilledState();
    const order = base.orders[0]!;
    const violations = invariantViolations(
      { ...base, orders: [{ ...order, executedNotional: order.executedNotional * 0.99 }] },
      0,
    );
    expect(violations.some((v) => v.startsWith("5: order 1 tradeNotional="))).toBe(true);
  });

  /**
   * 絶対項 `1e-12` は床として残してある。小さい注文では相対項がほぼ効かないので、
   * 大きさが小さい側の検査の厳しさは変えていない。
   */
  it("still flags a 1e-11 drift on a small order", () => {
    const order = buildOrder({ id: "1", startAmount: 0.001, executedAmount: 0.001, status: "FULLY_FILLED", executedNotional: 5_000 });
    const state = buildState({
      orders: [order],
      trades: [buildTrade({ orderId: "1", amount: 0.001 + 1e-11, price: 5_000_000, feeQuote: 0 })],
    });
    const violations = invariantViolations(state, 0);
    expect(violations.some((v) => v.startsWith("5: order 1 trades="))).toBe(true);
  });

  it("hold after random place/fill/cancel/reject sequences", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer(), fc.integer(), fc.integer()), {
          minLength: 1,
          maxLength: 40,
        }),
        (ops) => {
          // 数量を 8192 以上まで広げたので、残高も 40 操作ぶんの拘束（買いは
          // 1200 * 8200 ≒ 1e7 / 件）を飲み込める大きさにする。足りないと placeOrder が
          // INSUFFICIENT_FUNDS で断って、大きい数量の注文が 1 件も作られない。
          let state = buildState({ balances: { jpy: 10_000_000_000, btc: 1_000_000 } });
          const terminals = new Map<string, string>();
          for (const [kind, a, b] of ops) {
            const before = new Map(state.orders.filter(isTerminal).map((o) => [o.id, JSON.stringify(o)]));
            state = applyRandomOp(state, kind, a, b);
            expect(invariantViolations(state, 0)).toEqual([]);
            for (const [id, snap] of before) {
              const after = state.orders.find((o) => o.id === id);
              expect(after && JSON.stringify(after)).toBe(snap);
            }
            for (const o of state.orders) {
              if (isTerminal(o)) {
                terminals.set(o.id, JSON.stringify(o));
              }
            }
          }
          for (const [id, snap] of terminals) {
            const after = state.orders.find((o) => o.id === id);
            expect(after && JSON.stringify(after)).toBe(snap);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

/**
 * 6 本の不変量が成り立つための前提。7 本目の不変量ではないので `invariantViolations()` とは
 * 別の関数で、返す文字列の前置きも番号ではなく前提の名前になる（docs/fidelity.md の
 * 「不変量の前提」）。ここでは前提の側だけを見る。
 */
describe("invariant preconditions", () => {
  it("hold on a fresh state", () => {
    expect(preconditionViolations(buildState())).toEqual([]);
  });

  it("hold on a state with distinct ids, trades and a consistent sequence", () => {
    const state = buildState({
      balances: { jpy: 9_995_000, btc: 0.001 },
      orders: [
        buildOrder({ status: "FULLY_FILLED", executedAmount: 0.001, executedNotional: 5_000 }),
        buildOrder({ id: "2", side: "sell", price: 6_000_000 }),
      ],
      trades: [buildTrade()],
    });
    expect(preconditionViolations(state)).toEqual([]);
    expect(invariantViolations(state, 0)).toEqual([]);
  });

  // 同じ id のレコードが 2 件あると replaceOrder が id 一致の全件を置き換えるので、
  // active な方への約定が終端レコードまで書き換える（不変量 4 が破れる）。
  it("flag duplicate order ids with the id and the record count", () => {
    const state = buildState({
      orders: [buildOrder(), buildOrder({ status: "REJECTED" })],
    });
    expect(preconditionViolations(state)).toEqual(["order-id: duplicate order id 1 (2 records)"]);
  });

  it("flag duplicate trade ids", () => {
    const state = buildState({
      orders: [buildOrder({ status: "FULLY_FILLED", executedAmount: 0.002, executedNotional: 10_000 })],
      trades: [buildTrade(), buildTrade()],
    });
    expect(preconditionViolations(state)).toEqual(["trade-id: duplicate trade id 1 (2 records)"]);
  });

  // この state 自身に重複は無いが、採番が id 5 に追いつく 3 件目の発注で重複が生まれる。
  it("flag a sequence that is not greater than an existing id", () => {
    const orders = buildState({
      orders: [buildOrder({ id: "5", side: "sell" }), buildOrder({ id: "3", side: "sell" })],
      nextOrderSeq: 3,
    });
    expect(preconditionViolations(orders)).toEqual([
      "order-seq: nextOrderSeq=3 <= existing order id 5",
      "order-seq: nextOrderSeq=3 <= existing order id 3",
    ]);

    const trades = buildState({
      orders: [buildOrder({ status: "FULLY_FILLED", executedAmount: 0.001, executedNotional: 5_000 })],
      trades: [buildTrade({ tradeId: "2" })],
      nextTradeSeq: 1,
    });
    expect(preconditionViolations(trades)).toEqual([
      "trade-seq: nextTradeSeq=1 <= existing trade id 2",
    ]);
  });

  // 2^53 では `+ 1` が飽和して同じ id を配り続ける。既存 id と重ならなくても 2 件目で重複する。
  it("flag a saturated sequence without comparing it to existing ids", () => {
    const state = buildState({ nextOrderSeq: Number.MAX_SAFE_INTEGER + 1 });
    expect(preconditionViolations(state)).toEqual([
      "order-seq: nextOrderSeq=9007199254740992 exceeds Number.MAX_SAFE_INTEGER",
    ]);
  });

  // 採番は `String(seq)` を配るので、`"007"` や安全整数を超える表記の id とはぶつからない。
  it("do not flag ids the numbering can never issue", () => {
    const state = buildState({
      orders: [
        buildOrder({ id: "007", side: "sell" }),
        buildOrder({ id: "9007199254740993", side: "sell" }),
        buildOrder({ id: "0", side: "sell" }),
      ],
      nextOrderSeq: 1,
    });
    expect(preconditionViolations(state)).toEqual([]);
  });

  // 不変量 3 が条件に含む前提。残量 0 のまま永遠に active で、約定させる手段が無い。
  it("flag startAmount that is not positive", () => {
    const state = buildState({ orders: [buildOrder({ startAmount: 0 })] });
    expect(preconditionViolations(state)).toEqual(["start-amount: order 1 startAmount=0"]);
  });

  // 読み込みで前提を検査しても、起動後に遷移関数が前提を壊すなら意味がない。発注は
  // `String(nextOrderSeq)` を配って採番を 1 進めるだけなので、前提を満たす状態から
  // 始まる限り重複は生まれない。不変量と同じランダムな操作列で確かめる。
  it("hold after random place/fill/cancel/reject sequences", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer(), fc.integer(), fc.integer()), {
          minLength: 1,
          maxLength: 40,
        }),
        (ops) => {
          let state = buildState({ balances: { jpy: 10_000_000_000, btc: 1_000_000 } });
          expect(preconditionViolations(state)).toEqual([]);
          for (const [kind, a, b] of ops) {
            state = applyRandomOp(state, kind, a, b);
            expect(preconditionViolations(state)).toEqual([]);
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  // 前提と不変量は別物である。重複 id の state は 6 本の不変量をどれも破っていない。
  it("are disjoint from the six invariants", () => {
    const state = buildState({
      orders: [buildOrder(), buildOrder({ status: "REJECTED" })],
    });
    expect(invariantViolations(state, 0)).toEqual([]);
    expect(preconditionViolations(state)).toHaveLength(1);
  });
});
