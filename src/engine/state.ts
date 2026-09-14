import { z } from "zod";

export const ORDER_STATUSES = [
  "INACTIVE",
  "UNFILLED",
  "PARTIALLY_FILLED",
  "FULLY_FILLED",
  "CANCELED_UNFILLED",
  "CANCELED_PARTIALLY_FILLED",
  "REJECTED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_STATUSES = [
  "FULLY_FILLED",
  "CANCELED_UNFILLED",
  "CANCELED_PARTIALLY_FILLED",
  "REJECTED",
] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const OrderRecordSchema = z.object({
  id: z.string(),
  pair: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["limit", "market"]),
  price: z.number().nullable(),
  startAmount: z.number(),
  executedAmount: z.number(),
  executedNotional: z.number(),
  status: z.enum(ORDER_STATUSES),
  orderedAt: z.string(),
  canceledAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const TradeRecordSchema = z.object({
  tradeId: z.string(),
  orderId: z.string(),
  pair: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["limit", "market"]),
  amount: z.number(),
  price: z.number(),
  feeQuote: z.number(),
  makerTaker: z.enum(["maker", "taker"]),
  executedAt: z.string(),
});

export const PaperStateSchema = z.object({
  version: z.literal(3),
  createdAt: z.string(),
  updatedAt: z.string(),
  initialJpy: z.number(),
  lastTickAt: z.string(),
  balances: z.record(z.string(), z.number()),
  orders: z.array(OrderRecordSchema),
  trades: z.array(TradeRecordSchema),
  nextOrderSeq: z.number().int().positive(),
  nextTradeSeq: z.number().int().positive(),
});

export type OrderRecord = z.infer<typeof OrderRecordSchema>;
export type TradeRecord = z.infer<typeof TradeRecordSchema>;
export type PaperState = z.infer<typeof PaperStateSchema>;

// bitbank 公称テイカー手数料 0.12% (https://bitbank.cc/docs/fees/)
export const DEFAULT_TAKER_FEE_RATE = 0.0012;

export function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

export function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isActive(o: OrderRecord): boolean {
  return o.status === "UNFILLED" || o.status === "PARTIALLY_FILLED";
}

export function isTerminal(o: OrderRecord): boolean {
  return (TERMINAL_STATUSES as readonly OrderStatus[]).includes(o.status);
}

export function activeOrders(state: PaperState): OrderRecord[] {
  return state.orders.filter(isActive);
}

export function remainingOf(o: OrderRecord): number {
  return o.startAmount - o.executedAmount;
}

export function averagePriceOf(o: OrderRecord): number {
  return o.executedAmount === 0 ? 0 : o.executedNotional / o.executedAmount;
}

/**
 * ペアの 1 セグメントに許す文字種。英小文字と数字だけで、記号は許さない。
 *
 * 出典: bitbank-api-docs の pairs.md（コミット 0badd680）に載る 62 個のペア記号は
 * すべて「英小文字のみのセグメント」2 つを `_` で繋いだ形で、数字も記号も含まない。
 *
 * 数字まで許すのは公式より緩い保守的な上限。`[a-z]` に絞ると bitbank が数字を含む
 * ペアを足したときに弾いてしまうので、記号を落とすという目的に必要な分だけ残した。
 * 実在するペアかどうかは検査しない（未登録でも形が正しければ通す。docs/fidelity.md の
 * 「未登録ペアも同じ桁を仮置きする」を保つため）。ここで直したのは文字種であって実在性ではない。
 *
 * 記号を落とすことで、pair がそのまま外向き URL のパスセグメントへ流れる経路
 * （src/engine/candles.ts の fetchOneDay）で `..` / `?` / `#` や制御文字が効かなくなる。
 * URL 側でも別途エスケープしており、これはその 2 層目のうちの入口側。
 */
const PAIR_SEGMENT_RE = /^[a-z0-9]+$/;

export function pairAssets(pair: string): [string, string] | null {
  const parts = pair.split("_");
  if (parts.length !== 2) return null;
  const [base, quote] = parts;
  if (!base || !quote || base === quote) return null;
  if (!PAIR_SEGMENT_RE.test(base) || !PAIR_SEGMENT_RE.test(quote)) return null;
  return [base, quote];
}

export function lockedAssetOf(side: "buy" | "sell", pair: string): string | null {
  const assets = pairAssets(pair);
  if (!assets) return null;
  const [base, quote] = assets;
  return side === "buy" ? quote : base;
}

export function parseNumericId(id: string): number | null {
  if (!/^\d+$/.test(id)) return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}

/**
 * 採番（`nextOrderSeq` / `nextTradeSeq`）がいつか配り得る id なら、その連番を返す。
 * 配り得ないなら null。
 *
 * 配る id は `String(seq)` なので、対象は正の安全整数の正準な 10 進表記だけである。
 * `"007"` は `parseNumericId` では 7 になるが `String(7)` と一致しないので配られることはなく、
 * `"9007199254740993"` は倍精度で `9007199254740992` へ丸まるのでやはり一致しない。
 * `"0"` は採番が正の整数なので配られない。
 *
 * 「採番と既存 id の整合」を見る `preconditionViolations()`（`src/engine/invariants.ts`）と、
 * 移行が採番の初期値を決める `migrateToV3()`（`src/engine/persist.ts`）が同じ判定を共有する。
 * 判定がずれると、移行の出力が自分の検査に落ちる。
 */
export function issuedSeqOf(id: string): number | null {
  const n = parseNumericId(id);
  if (n == null || !Number.isSafeInteger(n) || n <= 0) return null;
  return String(n) === id ? n : null;
}

/**
 * 資産キーで引く地図から金額を読む。素の `{}` は `Object.prototype` を継承するので、
 * `constructor` のようにそこへ生えている名前の資産では、キーが無くても継承値（関数）が
 * 返り `?? 0` が素通りする。そのまま数値演算へ流すと `NaN` や文字列連結になり、
 * 不変量 6 の判定も残高の応答も壊れる。自分のキーだけを見て、無ければ 0 を返す。
 *
 * ペアのセグメントは `[a-z0-9]+` なので、この経路で当たる名前は `constructor` だけ。
 */
export function amountOf(map: Record<string, number>, asset: string): number {
  return Object.hasOwn(map, asset) ? map[asset] : 0;
}

/**
 * active な注文が拘束している量を資産ごとに集計する。買いは quote を手数料込みの
 * 残量 × 価格で、売りは base を残量で拘束する。成行の買い（`price == null`）と
 * 文字種が不正なペアの注文は拘束に数えない。
 *
 * 不変量 6（`locked <= 残高`）の左辺であり、`availableOf()` を通して発注時の
 * 残高ガードにも使う。手数料率は SessionStore が使う値と揃える必要がある。
 */
export function computeLocked(
  state: PaperState,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): Record<string, number> {
  // 資産名は state ファイル由来のペアから来る。継承を持たない地図で受けて、
  // 読み手が `locked[asset]` と素で引いても継承値を掴まないようにする。
  const locked: Record<string, number> = Object.create(null);
  for (const o of activeOrders(state)) {
    const assets = pairAssets(o.pair);
    if (!assets) continue;
    const [base, quote] = assets;
    const remaining = remainingOf(o);
    if (o.side === "buy") {
      if (o.price == null) continue;
      const cost = o.price * remaining * (1 + feeRate);
      locked[quote] = amountOf(locked, quote) + cost;
    } else {
      locked[base] = amountOf(locked, base) + remaining;
    }
  }
  return locked;
}

/** その資産で新たに発注に使える量（残高 − 拘束）。負になり得る。 */
export function availableOf(
  state: PaperState,
  asset: string,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): number {
  const total = amountOf(state.balances, asset);
  const locked = amountOf(computeLocked(state, feeRate), asset);
  return total - locked;
}
