export type Envelope<T> =
  | { success: 1; data: T }
  | { success: 0; data: { code: number } };

export function ok<T>(data: T): Envelope<T> {
  return { success: 1, data };
}

/**
 * 失敗の封筒。**HTTP ステータスは触らない（互換ルートは常に 200）。**
 *
 * かつては「ルート層で弾いた欠落・不正値は 400、engine 層まで進んだ業務エラーは 200」と
 * 分けていたが、**実 API は区別せず 200 を返す**ことを実測した（2026-09-17、17 経路。
 * 欠落・数値でない値・不正なペア・注文が見つからない、のすべて）。失敗は封筒の
 * `success: 0` だけが表す。
 *
 * そのため互換ルートのハンドラは `reply` を受け取っていない。ステータスを触りたく
 * なったら、まず `docs/fidelity.md` の「エラーコード」行の実測を読むこと。
 *
 * 例外は経路が決まらない要求で、そこは 200 ではない（`/v1/` 直下の未知パスは
 * 実 API も 404 + 封筒 `10000`）。`/_control/` は bitbank API に無い口なので、
 * この規則の対象外（素の JSON + HTTP ステータス）。
 */
export function err(code: number): Envelope<never> {
  return { success: 0, data: { code } };
}

// 出典: https://github.com/bitbankinc/bitbank-api-docs/blob/0badd68019646171826625b074cfef4235c3e713/errors.md
// 公式と違う意味に流用しているコードは docs/fidelity.md の「エラーコード」行に記録する
// （20003 / 60004）。errors.md に定義の無い番号は置かない。
export const ErrorCode = {
  /**
   * "Url not found."
   *
   * **かつて不正なペアに流用していたが、やめた**（`INVALID_ASSET` に移した）。実 API が
   * この番号を返すのは経路が見つからないときで、`GET /v1/nonexistent` を**認証ヘッダ無しで**
   * 叩くと `HTTP 404` + 封筒 `10000` を観測できる（2026-09-17）。
   * モックの未登録パスはまだ Fastify の素の 404 で、封筒に包んでいない（別 PR）。
   */
  URL_NOT_FOUND: 10000,
  INVALID_AUTH: 20001,
  INVALID_PARAMETER: 20003,
  MISSING_AMOUNT: 30001,
  MISSING_ORDER_ID: 30006,
  MISSING_ORDER_IDS: 30007,
  /** "Missing asset." 実 API は `pair` の欠落にこれを返す（2026-09-17 実測）。 */
  MISSING_ASSET: 30009,
  MISSING_PRICE: 30012,
  MISSING_SIDE: 30013,
  MISSING_TYPE: 30015,
  // 絞り込みパラメータごとの不正値コード（40006 / 40007 / 40008 / 40009 / 40022 の 5 つ。
  // 間に挟まる 40017 はペアのコードでこの群ではない）。**汎用の 20003 ではなくこれらを
  // 返すことを実 API で実測した**（docs/fidelity.md の「絞り込みパラメータの不正値」）。
  // 括弧内は errors.md の該当メッセージで、番号を同定した根拠。
  // パラメータ名との対応は src/routes/params.ts の QUERY_PARAM_CODES が持つ。
  INVALID_COUNT: 40006, // "Invalid count."
  INVALID_END: 40007, // "Invalid end param."
  INVALID_END_ID: 40008, // "Invalid end_id."
  INVALID_FROM_ID: 40009, // "Invalid from_id."
  /** "Invalid asset." 実 API は不正なペアにこれを返す（2026-09-17 実測）。絞り込み群ではない。 */
  INVALID_ASSET: 40017,
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
