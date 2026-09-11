import { computeLocked, DEFAULT_TAKER_FEE_RATE, isTerminal, type PaperState } from "./state.ts";

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
    const total = state.balances[k] ?? 0;
    const lockedAmount = locked[k] ?? 0;
    if (total < -1e-9) {
      violations.push(`6: balance[${k}]=${total} is negative`);
    }
    if (lockedAmount - total > 1e-9) {
      violations.push(`6: locked[${k}]=${lockedAmount} exceeds balance=${total}`);
    }
  }

  return violations;
}
