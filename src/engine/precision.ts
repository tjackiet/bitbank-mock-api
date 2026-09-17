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

/**
 * 桁に載っているかの判定に使う、スケール後の値と整数の差の許容幅。
 *
 * **桁の検査は量を格子へ載せる保証ではない**（docs/fidelity.md の不変量 5 の節の末尾）。
 * この幅はスケール後に当てるので、`amount` 側で許される幅は桁だけで決まり**大きさに依らない**。
 * 桁 4 なら `1e-8 / 1e4 = 1e-12` で、`startAmount` が `8192` を超えるあたりで倍精度の
 * 1 ulp と同じ大きさになる。量を本当に格子へ量子化するのは Phase 2（整数最小単位への移行）の話。
 */
const DIGIT_FIT_EPS = 1e-8;

export function fitsDigits(n: number, digits: number): boolean {
  if (!Number.isFinite(n)) return false;
  const factor = 10 ** digits;
  const scaled = n * factor;
  return Math.abs(scaled - Math.round(scaled)) < DIGIT_FIT_EPS;
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
