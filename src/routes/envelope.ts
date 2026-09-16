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
  // 絞り込みパラメータごとの不正値コード。**汎用の 20003 ではなくこれらを返すことを
  // 実 API で実測した**（docs/fidelity.md の「絞り込みパラメータの不正値」）。
  // 括弧内は errors.md の該当メッセージで、番号を同定した根拠。
  // パラメータ名との対応は src/routes/params.ts の QUERY_PARAM_CODES が持つ。
  INVALID_COUNT: 40006, // "Invalid count."
  INVALID_END: 40007, // "Invalid end param."
  INVALID_END_ID: 40008, // "Invalid end_id."
  INVALID_FROM_ID: 40009, // "Invalid from_id."
  INVALID_SINCE: 40022, // "Invalid trading start time."
  ORDER_NOT_FOUND: 50009,
  ALREADY_CANCELED: 50026,
  ALREADY_EXECUTED: 50027,
  INSUFFICIENT_FUNDS: 60001,
  AMOUNT_PRECISION: 60004,
  INTERNAL: 70001,
} as const;

/**
 * 封筒に出る error code の型。`ErrorCode` のメンバの値だけを受ける。
 *
 * error code の定義元をこのファイルに 1 つだけ保つための型。番号を別の場所へ書き写すと
 * 定義元が 2 つになり、片方だけ直した変更が型にもテストにも引っかからないまま
 * wire に出る値だけを変える。番号を持つ地図はこの型で締めて、`ErrorCode` に無い数値を
 * 書いたら typecheck が落ちるようにする（`src/routes/params.ts` の `QUERY_PARAM_CODES`）。
 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
