export type Envelope<T> =
  | { success: 1; data: T }
  | { success: 0; data: { code: number } };

export function ok<T>(data: T): Envelope<T> {
  return { success: 1, data };
}

export function err(code: number): Envelope<never> {
  return { success: 0, data: { code } };
}

// 出典: https://github.com/bitbankinc/bitbank-api-docs/blob/0badd68019646171826625b074cfef4235c3e713/errors.md
// 公式と違う意味に流用しているコードは docs/fidelity.md の「エラーコード」行に記録する
// （10000 / 20003 / 60004）。errors.md に定義の無い番号は置かない。
export const ErrorCode = {
  INVALID_PAIR: 10000,
  INVALID_AUTH: 20001,
  INVALID_PARAMETER: 20003,
  MISSING_AMOUNT: 30001,
  MISSING_ORDER_ID: 30006,
  MISSING_ORDER_IDS: 30007,
  MISSING_PRICE: 30012,
  MISSING_SIDE: 30013,
  MISSING_TYPE: 30015,
  // 絞り込みパラメータごとの不正値コード。実 API が汎用コードではなくこれらを返すことを
  // 実測した（docs/fidelity.md の「絞り込みパラメータの不正値」）。
  INVALID_COUNT: 40006,
  INVALID_END: 40007,
  INVALID_END_ID: 40008,
  INVALID_FROM_ID: 40009,
  INVALID_SINCE: 40022,
  ORDER_NOT_FOUND: 50009,
  ALREADY_CANCELED: 50026,
  ALREADY_EXECUTED: 50027,
  INSUFFICIENT_FUNDS: 60001,
  AMOUNT_PRECISION: 60004,
  INTERNAL: 70001,
} as const;
