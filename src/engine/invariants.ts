import {
  activeOrders,
  computeLocked,
  DEFAULT_TAKER_FEE_RATE,
  isTerminal,
  remainingOf,
  type PaperState,
} from "./state.ts";

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

    if (o.status === "FULLY_FILLED" && o.executedAmount !== o.startAmount) {
      violations.push(`3: order ${o.id} FULLY_FILLED executedAmount=${o.executedAmount}`);
    }
    if (o.executedAmount === o.startAmount && o.startAmount > 0 && o.status !== "FULLY_FILLED") {
      violations.push(`3: order ${o.id} fully executed but status=${o.status}`);
    }

    const tradeSum = state.trades
      .filter((t) => t.orderId === o.id)
      .reduce((sum, t) => sum + t.amount, 0);
    if (Math.abs(tradeSum - o.executedAmount) > 1e-12) {
      violations.push(
        `5: order ${o.id} trades=${tradeSum} executedAmount=${o.executedAmount}`,
      );
    }
  }

  const expected: Record<string, number> = {};
  for (const o of activeOrders(state)) {
    const [base, quote] = o.pair.split("_");
    if (!base || !quote) continue;
    const remaining = remainingOf(o);
    if (o.side === "buy") {
      if (o.price == null) continue;
      expected[quote] = (expected[quote] ?? 0) + o.price * remaining * (1 + feeRate);
    } else {
      expected[base] = (expected[base] ?? 0) + remaining;
    }
  }
  const locked = computeLocked(state, feeRate);
  const keys = new Set([...Object.keys(expected), ...Object.keys(locked)]);
  for (const k of keys) {
    if (Math.abs((expected[k] ?? 0) - (locked[k] ?? 0)) > 1e-9) {
      violations.push(`6: locked[${k}] expected=${expected[k] ?? 0} actual=${locked[k] ?? 0}`);
    }
  }

  return violations;
}
