export type PairPrecision = {
  amountDigits: number;
  priceDigits: number;
};

/** Plan A 定数。出典: GET /spot/pairs の amount_digits / price_digits（btc_jpy）。 */
export const BTC_JPY_PRECISION: PairPrecision = {
  amountDigits: 4,
  priceDigits: 0,
};

const PAIR_PRECISION: Record<string, PairPrecision> = {
  btc_jpy: BTC_JPY_PRECISION,
};

/**
 * 未登録ペアは btc_jpy と同じ JPY スポット桁（数量 4・価格 0）を仮置きする。
 *
 * ペア名は state ファイルやリクエスト由来なので、`Object.prototype` が持つ名前で
 * 引かれると素の `[pair] ?? 既定` は継承値を返す。自分のキーだけを見る。
 */
export function precisionOf(pair: string): PairPrecision {
  return Object.hasOwn(PAIR_PRECISION, pair) ? PAIR_PRECISION[pair] : BTC_JPY_PRECISION;
}

export function fitsDigits(n: number, digits: number): boolean {
  if (!Number.isFinite(n)) return false;
  const factor = 10 ** digits;
  const scaled = n * factor;
  return Math.abs(scaled - Math.round(scaled)) < 1e-8;
}

export function formatFixed(n: number, digits: number): string {
  return n.toFixed(digits);
}

export function formatAmount(pair: string, n: number): string {
  return formatFixed(n, precisionOf(pair).amountDigits);
}

export function formatPrice(pair: string, n: number): string {
  return formatFixed(n, precisionOf(pair).priceDigits);
}

export function priceUnit(pair: string): number {
  return 10 ** -precisionOf(pair).priceDigits;
}
