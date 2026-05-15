export type Envelope<T> =
  | { success: 1; data: T }
  | { success: 0; data: { code: number } };

export function ok<T>(data: T): Envelope<T> {
  return { success: 1, data };
}

export function err(code: number): Envelope<never> {
  return { success: 0, data: { code } };
}

// 最小限の公称エラーコード。完全網羅は P1。
// 参考: https://github.com/bitbankinc/bitbank-api-docs/blob/master/errors.md
export const ErrorCode = {
  INVALID_PARAMETER: 20003,
  INVALID_AUTH: 20001,
  NONCE_REQUIRED: 20011,
  ORDER_NOT_FOUND: 50009,
  INSUFFICIENT_FUNDS: 50008,
  INVALID_AMOUNT: 30009,
  INVALID_PRICE: 30013,
  INVALID_PAIR: 10000,
  UNSUPPORTED_ORDER_TYPE: 30005,
  INTERNAL: 70001,
} as const;
