import {
  amountOf,
  computeLocked,
  DEFAULT_TAKER_FEE_RATE,
  isTerminal,
  issuedSeqOf,
  type PaperState,
} from "./state.ts";

/**
 * 不変量 5 の `amount` の合計に使う許容差の絶対項。大きさが 1 前後より小さい側の床。
 *
 * `src/engine/transitions.ts` の `AMOUNT_EPS` と**同じ値だが別物**。あちらは `fillOrder` が
 * 全約定へクランプする閾値で、こちらは合計の一致を見る許容差の床である。**連動しない**:
 * `AMOUNT_EPS` を `1e-6` へ緩めても不変量 5 の違反は 0 のままになる（実測）。クランプは
 * trade の `amount` も残量ちょうどへ丸めるので、両辺が同じ値で動くためである。
 * 片方を動かすときもう片方を追従させる必要は無い。
 */
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
 * 不変量 6（残高が負でない・拘束が残高を超えない）の許容差。
 *
 * **この値の根拠は記録されていない。** v3 の遷移を入れた最初のコミット（`02fc047`）から
 * 同じ値が使われており、導出も出典も残っていない。docs/fidelity.md は値そのものは
 * 記録しているが（不変量 6 の行）、なぜ `1e-9` かは書いていない。
 *
 * **固定の絶対値なので、残高が大きいほど厳しい検査になる。** 実測では残高の大きさが
 * 約 `8.39e6`（= `2^23`）を超えると `1e-9` が 1 ulp を下回る。これは不変量 5 で
 * 実際に起きた破れ方と同じ形である（docs/fidelity.md の「不変量 5 と `fillOrder` の
 * クランプ」。あちらは `startAmount > 8192` が閾値だった）。
 *
 * ただし**遷移関数だけを通って誤判定になる具体例は作れていない**ので、不変量 5 のように
 * 大きさへ比例させる変更は入れていない（docs/fidelity.md に未確定として記録した）。
 * 推測で許容差を動かすと、今度は本物の違反を見逃す側へ倒れる。
 */
const BALANCE_ABS_TOL = 1e-9;

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
 * 6 本が成り立つための**前提**（id の一意性など）はここでは見ない。前提は 7 本目の
 * 不変量ではないので、下の `preconditionViolations()` が別に見る。
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
    if (total < -BALANCE_ABS_TOL) {
      violations.push(`6: balance[${k}]=${total} is negative`);
    }
    if (lockedAmount - total > BALANCE_ABS_TOL) {
      violations.push(`6: locked[${k}]=${lockedAmount} exceeds balance=${total}`);
    }
  }

  return violations;
}

/**
 * 同じ値が 2 件以上ある id を、最初に現れた順に「id → 件数」で返す。
 */
function duplicateIds(ids: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return new Map([...counts].filter(([, n]) => n > 1));
}

/**
 * 採番と既存 id の整合を見る。採番が既存 id 以下だと、採番がその id に追いつく発注で
 * id が重複する（`nextOrderSeq = 3` で id `5` の注文があると、配られる id は `3` → `4` → `5`
 * で 3 件目が重なる）。
 *
 * **採番が安全整数を超えていること自体は違反にしない。** `+ 1` が飽和して同じ id を配り続ける
 * のは確かだが、配る側（`src/engine/transitions.ts` の `canIssue()`）が飽和した採番から id を
 * 配らないので、重複は起きない。飽和した採番は「壊れている」のではなく「使い切った」状態で、
 * 新しい発注が `ORDER_SEQ_EXHAUSTED` で断られるだけである。
 *
 * ここで落とすと、**遷移関数だけを通って作った状態が次の起動で読めなくなる**。
 * `nextOrderSeq = Number.MAX_SAFE_INTEGER` の state は id `9007199254740991` を 1 件配れて、
 * そのとき書き出される採番は `9007199254740992` になるからである（不変量 5 の許容差で
 * 起きたのと同じ型の不具合。docs/fidelity.md の「不変量 5 と `fillOrder` のクランプ」）。
 *
 * 飽和した採番は比較にも影響しない。`issuedSeqOf()` が安全整数でない id を除くので、
 * 比較対象の id はすべて `2^53` 未満であり、飽和した採番より小さい。
 */
function seqViolations(kind: "order" | "trade", seq: number, ids: string[]): string[] {
  const field = kind === "order" ? "nextOrderSeq" : "nextTradeSeq";
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const n = issuedSeqOf(id);
    if (n == null || n < seq || seen.has(id)) continue;
    seen.add(id);
    violations.push(`${kind}-seq: ${field}=${seq} <= existing ${kind} id ${id}`);
  }
  return violations;
}

/**
 * 6 本の不変量が成り立つための**前提**の違反を並べる。違反が無ければ空配列。
 *
 * これは 7 本目の不変量ではない。6 本は本モックの前提条件として固定してあり、本数も内容も変えない
 * （docs/fidelity.md の「状態の不変量（PaperState v3）」）。ここで見るのは、その 6 本の主張と
 * `invariantViolations()` の検査が意味を持つために必要な前提である。だから関数を分け、返す
 * 文字列の前置きも不変量の番号ではなく前提の名前（`order-id` / `trade-id` / `order-seq` /
 * `trade-seq` / `start-amount`）にしてある。
 *
 * 見るのは 3 つ。
 *
 * - **注文 id / trade id の一意性。** 同じ id のレコードが 2 件あると `replaceOrder()`
 *   （`src/engine/transitions.ts`）が id 一致の全件を置き換えるので、active な方への約定が
 *   終端レコードまで書き換えて不変量 4 が破れる。`runTick()` は同じ id を 2 回 `applyFill()` へ
 *   渡すので 2 件目が `ORDER_NOT_ACTIVE` で失敗し、その tick は 1 件も約定しないまま断られる
 *   （`POST /_control/tick` は 400）。先頭が終端レコードなら取消も約定もできない注文が残る。
 *   trade id の重複は `trade_history` に同じ行を 2 つ出す。
 * - **採番と既存 id の整合。** 一意性は「これから配る id が既存 id と重ならない」ことに
 *   依存する。判定は上の `seqViolations()` にある。採番が安全整数を使い切った状態は違反に
 *   しない（配る側が止めるので重複しない。同じく `seqViolations()` の項）。
 * - **`startAmount > 0`。** 不変量 3（`FULLY_FILLED` ⇔ `executedAmount == startAmount`）が
 *   条件に含む前提。`startAmount == 0` の注文は残量 0 のまま永遠に active で、`fillOrder` が
 *   非正の量を断るので約定させる手段が無い。
 *
 * 返す文字列は `<前提の名前>: <対象を特定する識別子と値>` の形で、そのまま起動失敗の
 * メッセージに載る（`src/engine/persist.ts` の `loadState()`）。
 */
export function preconditionViolations(state: PaperState): string[] {
  const violations: string[] = [];

  for (const [id, count] of duplicateIds(state.orders.map((o) => o.id))) {
    violations.push(`order-id: duplicate order id ${id} (${count} records)`);
  }
  for (const [id, count] of duplicateIds(state.trades.map((t) => t.tradeId))) {
    violations.push(`trade-id: duplicate trade id ${id} (${count} records)`);
  }

  violations.push(...seqViolations("order", state.nextOrderSeq, state.orders.map((o) => o.id)));
  violations.push(...seqViolations("trade", state.nextTradeSeq, state.trades.map((t) => t.tradeId)));

  for (const o of state.orders) {
    // `> 0` の否定なので 0・負・NaN をまとめて拾う（負は不変量 1 も捕まえる）。
    if (!(o.startAmount > 0)) {
      violations.push(`start-amount: order ${o.id} startAmount=${o.startAmount}`);
    }
  }

  return violations;
}
