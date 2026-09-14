import {
  amountOf,
  computeLocked,
  DEFAULT_TAKER_FEE_RATE,
  isTerminal,
  type PaperState,
} from "./state.ts";

/** 不変量 5 の `amount` の合計に使う許容差の絶対項。大きさが 1 前後より小さい側の床。 */
const AMOUNT_ABS_TOL = 1e-12;

/** 不変量 5 の `amount × price` の合計に使う許容差の絶対項。 */
const NOTIONAL_ABS_TOL = 1e-6;

/**
 * 合計の一致に許す相対誤差。倍精度の 4 ulp 相当（`Number.EPSILON` は 1 ulp の上界）。
 *
 * 遷移関数だけを通って作った状態のずれは**高々 1 ulp** に収まる。`fillOrder` は部分約定の
 * たびに trade と同じ値を同じ順序で `executedAmount` へ足すので、最後の全約定クランプまでは
 * 合計と完全に一致する。クランプは `executedAmount` を `startAmount` へ置くだけなので、残る
 * ずれは最後の 1 件の丸め（`<= ulp(fillAmount)/2`）と最後の加算の丸め（`<= ulp(startAmount)/2`）
 * の和、すなわち `<= ulp(startAmount) <= Number.EPSILON * startAmount` である。約定件数には
 * 依らない。4 倍はその上界に対する余裕（実測の最大は `0.90 * Number.EPSILON`）。
 */
const SUM_REL_TOL = 4 * Number.EPSILON;

/**
 * 合計が `executedAmount` / `executedNotional` と一致していないか。
 *
 * 「`trades` の合計 == `executedAmount`」は実数の等式で、倍精度で評価すると両辺とも
 * 大きさに比例した丸め誤差を持つ。固定の絶対値を当てると大きさが増えるほど厳しい検査に
 * なり、主張したい等式より強いことを要求してしまう。実際 `startAmount` が `8192` を超えると
 * 1 ulp が `1e-12` を上回り、遷移関数だけを通って作った状態が違反と判定されて次の起動が
 * 止まっていた（docs/fidelity.md の同節）。そこで許容差を比べる量の大きさへ比例させる。
 * **等式そのものは緩めていない**。絶対項 `absTol` は従来の値をそのまま床に使うので、
 * 大きさが小さい注文に対する検査の厳しさは変わらない。
 *
 * 片方が NaN だと比較が false になり違反に数えないが、これは変更前と同じで、非数の
 * `executedAmount` は不変量 1 が捕まえる。
 */
function sumMismatch(sum: number, expected: number, absTol: number): boolean {
  const scale = Math.max(Math.abs(sum), Math.abs(expected));
  return Math.abs(sum - expected) > absTol + SUM_REL_TOL * scale;
}

/**
 * 単一の状態から判定できる不変量の違反を並べる。違反が無ければ空配列。
 *
 * docs/fidelity.md の「状態の不変量（PaperState v3）」6 本のうち、ここで見るのは
 * 1〜3・5・6 である。不変量 4（終端のレコードは以後変化しない）は 2 つの状態を
 * 比べる性質なので対象外で、遷移関数のガードとプロパティテストが担保する。
 *
 * 返す文字列は `<不変量の番号>: <対象を特定する識別子と値>` の形で、そのまま
 * 起動失敗のメッセージに載る（`src/engine/persist.ts` の `loadState()`）。
 * 不変量 5 の合計の一致は倍精度の丸め誤差を吸収する許容差つきで判定する。許容差は
 * 絶対項（`amount` は `1e-12`、`amount × price` は `1e-6`）と、比べる量の大きさへ比例する
 * 相対項の和で、定義は上の `sumMismatch()` にある。
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
    if (sumMismatch(tradeSum, o.executedAmount, AMOUNT_ABS_TOL)) {
      violations.push(`5: order ${o.id} trades=${tradeSum} executedAmount=${o.executedAmount}`);
    }
    const notionalSum = fills.reduce((sum, t) => sum + t.amount * t.price, 0);
    if (sumMismatch(notionalSum, o.executedNotional, NOTIONAL_ABS_TOL)) {
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
