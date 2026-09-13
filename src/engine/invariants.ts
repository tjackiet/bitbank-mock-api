import {
  amountOf,
  computeLocked,
  DEFAULT_TAKER_FEE_RATE,
  isTerminal,
  type PaperState,
} from "./state.ts";

/**
 * 単一の状態から判定できる不変量の違反を並べる。違反が無ければ空配列。
 *
 * docs/fidelity.md の「状態の不変量（PaperState v3）」6 本のうち、ここで見るのは
 * 1〜3・5・6 である。不変量 4（終端のレコードは以後変化しない）は 2 つの状態を
 * 比べる性質なので対象外で、遷移関数のガードとプロパティテストが担保する。
 *
 * 返す文字列は `<不変量の番号>: <対象を特定する識別子と値>` の形で、そのまま
 * 起動失敗のメッセージに載る（`src/engine/persist.ts` の `loadState()`）。
 * 不変量 5 の合計の一致は倍精度の丸め誤差を吸収する許容差つきで判定する
 * （`amount` は `1e-12`、`amount × price` は `1e-6`）。
 *
 * 費用は注文ごとに `state.trades` を走査するので注文数 × 約定数に比例する。
 * 読み込み時に 1 回だけ呼ぶ想定で、書き込みのたびには呼んでいない。
 */
export function invariantViolations(
  state: PaperState,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): string[] {
  const violations: string[] = [];

  for (const o of state.orders) {
    if (!(o.executedAmount >= 0 && o.executedAmount <= o.startAmount)) {
      violations.push(`1: order ${o.id} executedAmount=${o.executedAmount} startAmount=${o.startAmount}`);
    }

    if (o.status === "INACTIVE" || o.status === "UNFILLED") {
      if (o.executedAmount !== 0 || isTerminal(o)) {
        violations.push(`2: order ${o.id} status=${o.status} executedAmount=${o.executedAmount}`);
      }
    }
    if (o.executedAmount === 0 && !isTerminal(o)) {
      if (o.status !== "INACTIVE" && o.status !== "UNFILLED") {
        violations.push(`2: order ${o.id} zero-exec non-terminal status=${o.status}`);
      }
    }
    if (o.status === "REJECTED" && o.executedAmount !== 0) {
      violations.push(`2: order ${o.id} REJECTED with executedAmount=${o.executedAmount}`);
    }
    if (o.status === "CANCELED_UNFILLED" && o.executedAmount !== 0) {
      violations.push(`2: order ${o.id} CANCELED_UNFILLED with executedAmount=${o.executedAmount}`);
    }
    if (o.status === "CANCELED_PARTIALLY_FILLED" && o.executedAmount <= 0) {
      violations.push(`2: order ${o.id} CANCELED_PARTIALLY_FILLED with executedAmount=${o.executedAmount}`);
    }

    if (o.status === "FULLY_FILLED" && o.executedAmount !== o.startAmount) {
      violations.push(`3: order ${o.id} FULLY_FILLED executedAmount=${o.executedAmount}`);
    }
    if (o.executedAmount === o.startAmount && o.startAmount > 0 && o.status !== "FULLY_FILLED") {
      violations.push(`3: order ${o.id} fully executed but status=${o.status}`);
    }

    const fills = state.trades.filter((t) => t.orderId === o.id);
    const tradeSum = fills.reduce((sum, t) => sum + t.amount, 0);
    if (Math.abs(tradeSum - o.executedAmount) > 1e-12) {
      violations.push(`5: order ${o.id} trades=${tradeSum} executedAmount=${o.executedAmount}`);
    }
    const notionalSum = fills.reduce((sum, t) => sum + t.amount * t.price, 0);
    if (Math.abs(notionalSum - o.executedNotional) > 1e-6) {
      violations.push(
        `5: order ${o.id} tradeNotional=${notionalSum} executedNotional=${o.executedNotional}`,
      );
    }
  }

  const orderIds = new Set(state.orders.map((o) => o.id));
  for (const t of state.trades) {
    if (!orderIds.has(t.orderId)) {
      violations.push(`5: trade ${t.tradeId} has no order ${t.orderId}`);
    }
  }

  const locked = computeLocked(state, feeRate);
  const keys = new Set([...Object.keys(state.balances), ...Object.keys(locked)]);
  for (const k of keys) {
    const total = amountOf(state.balances, k);
    const lockedAmount = amountOf(locked, k);
    if (total < -1e-9) {
      violations.push(`6: balance[${k}]=${total} is negative`);
    }
    if (lockedAmount - total > 1e-9) {
      violations.push(`6: locked[${k}]=${lockedAmount} exceeds balance=${total}`);
    }
  }

  return violations;
}
