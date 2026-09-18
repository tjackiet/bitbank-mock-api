/**
 * 公式ドキュメントの応答表から書き写したフィールド定義。
 *
 * 出典は bitbankinc/bitbank-api-docs のコミット 0badd68019646171826625b074cfef4235c3e713
 * （`docs/fidelity.md` の「出典」節が固定する版）の `rest-api.md`。
 *
 * **実装（`src/routes/format.ts` の `OrderShape` / `TradeShape`）からは導かない。**
 * 期待値を実装の型から組み立てると、実装が公式から外れたときにテストも一緒に外れる。
 * 各定数のコメントに応答表の該当行をそのまま引用する。
 */

/** 値の型検査。公式の Type 欄をそのまま述語にする。 */
export type FieldCheck = (v: unknown) => boolean;

const isString: FieldCheck = (v) => typeof v === "string";
const isNumber: FieldCheck = (v) => typeof v === "number" && Number.isFinite(v);
const isBoolean: FieldCheck = (v) => typeof v === "boolean";
const isNumberOrNull: FieldCheck = (v) => v === null || isNumber(v);
const isStringOrNull: FieldCheck = (v) => v === null || isString(v);

/**
 * `Fetch order information` の応答表のうち、条件なしで必ず出るフィールド。
 *
 * ```
 * order_id | number | order id
 * pair | string | pair enum
 * side | string | `buy` or `sell`
 * type | string | one of `limit`, `market`, `stop`, ...
 * start_amount | string | null | order qty when placed
 * remaining_amount | string | null | qty not executed
 * executed_amount| string | qty executed
 * user_cancelable | boolean | whether cancelable order or not
 * average_price | string | avg executed price
 * ordered_at | number | ordered at unix timestamp (milliseconds)
 * expire_at | number | null | expiration time in unix timestamp (milliseconds)
 * status | string | status enum: ...
 * ```
 *
 * 同じ表を `Create new order` / `Cancel order` も持ち、`Fetch multiple orders` と
 * `Fetch active orders` は "list of object same as Fetch order information response"
 * と定義する。つまり 5 節すべてがこの集合を共有する。
 */
export const OFFICIAL_ORDER_FIELDS: Record<string, FieldCheck> = {
  order_id: isNumber,
  pair: isString,
  side: isString,
  type: isString,
  start_amount: isStringOrNull,
  remaining_amount: isStringOrNull,
  executed_amount: isString,
  user_cancelable: isBoolean,
  average_price: isString,
  ordered_at: isNumber,
  expire_at: isNumberOrNull,
  status: isString,
};

/**
 * 条件付きで出るフィールド。条件は公式の Description 欄をそのまま写す。
 *
 * ```
 * price | string | undefined | order price (present only if type = `limit` or `stop_limit`)
 * post_only | boolean | undefined | whether Post Only or not (present only if type = `limit`)
 * canceled_at | number | canceled at unix timestamp (milliseconds)   ← Cancel order の表のみ
 * ```
 *
 * `canceled_at` を応答表に持つのは `Cancel order` だけで、`Fetch order information` の
 * 表には無い。本モックの扱いは `docs/fidelity.md` の「注文の `canceled_at`」節を参照。
 */
export const OFFICIAL_ORDER_CONDITIONAL_FIELDS: Record<string, FieldCheck> = {
  price: isString,
  post_only: isBoolean,
  canceled_at: isNumber,
};

/**
 * 公式の応答表にはあるが、本モックが機能自体を実装しないので常に出さないフィールド。
 * 省略は欠陥ではない（README の「非目標（Plan A）」）。テストは「出ていないこと」を固定する。
 *
 * ```
 * position_side | string | undefined | `long` or `short`(only for margin trading)
 * triggered_at | number | undefined | ... (present only if type = `stop`, `stop_limit`, ...)
 * trigger_price | string | undefined | trigger price (present only if type = `stop`, ...)
 * ```
 */
export const UNIMPLEMENTED_ORDER_FIELDS = ["position_side", "triggered_at", "trigger_price"];

/**
 * status enum は節ごとに集合が違うので、節ごとに別の定数として写す。
 * 広い方（7 値）で全経路を検査すると、`REJECTED` を返してはいけない経路で
 * `REJECTED` が素通りする。
 *
 * `Fetch order information`（`Fetch multiple orders` / `Fetch active orders` も
 * この節を参照する）。`REJECTED` を含む 7 値。
 *
 * ```
 * status | string | status enum: `INACTIVE`, `UNFILLED`, `PARTIALLY_FILLED`, `FULLY_FILLED`, `CANCELED_UNFILLED`, `CANCELED_PARTIALLY_FILLED`, `REJECTED`
 * ```
 */
export const OFFICIAL_FETCH_ORDER_STATUSES = [
  "INACTIVE",
  "UNFILLED",
  "PARTIALLY_FILLED",
  "FULLY_FILLED",
  "CANCELED_UNFILLED",
  "CANCELED_PARTIALLY_FILLED",
  "REJECTED",
];

/**
 * `Create new order`。`REJECTED` を含まない 6 値。
 *
 * ```
 * status | string | status enum: `INACTIVE`, `UNFILLED`, `PARTIALLY_FILLED`, `FULLY_FILLED`, `CANCELED_UNFILLED`, `CANCELED_PARTIALLY_FILLED`
 * ```
 */
export const OFFICIAL_CREATE_ORDER_STATUSES = [
  "INACTIVE",
  "UNFILLED",
  "PARTIALLY_FILLED",
  "FULLY_FILLED",
  "CANCELED_UNFILLED",
  "CANCELED_PARTIALLY_FILLED",
];

/**
 * `Cancel order`（`Cancel multiple orders` もこの節を参照する）。`REJECTED` を
 * 含まない 6 値。`Create new order` と同じ並びだが、別の節の別の表なので
 * 独立に写す（一方だけが変わりうる）。
 *
 * ```
 * status | string | status enum: `INACTIVE`, `UNFILLED`, `PARTIALLY_FILLED`, `FULLY_FILLED`, `CANCELED_UNFILLED`, `CANCELED_PARTIALLY_FILLED`
 * ```
 */
export const OFFICIAL_CANCEL_ORDER_STATUSES = [
  "INACTIVE",
  "UNFILLED",
  "PARTIALLY_FILLED",
  "FULLY_FILLED",
  "CANCELED_UNFILLED",
  "CANCELED_PARTIALLY_FILLED",
];

/**
 * `Fetch trade history` の応答表。`position_side` / `profit_loss` / `interest` を除く全行。
 *
 * ```
 * trade_id | number | trade id
 * pair | string | pair enum
 * order_id | number | order id
 * side | string | `buy` or `sell`
 * type | string | one of `limit`, `market`, `stop`, ...
 * amount | string | amount
 * price | string | order price
 * maker_taker | string | maker or taker
 * fee_amount_base | string | base asset fee amount
 * fee_amount_quote | string | quote asset fee amount
 * fee_occurred_amount_quote | string | quote fee occurred amount which taken later.
 *                                      In case of spot trading, this value is same as fee_amount_quote.
 * executed_at | number | order executed at unix timestamp (milliseconds)
 * ```
 *
 * `fee_occurred_amount_quote` の Type 欄は `string` で、`| undefined` が付かない。
 * 応答例の JSON には無いが、型が必須である以上こちらを正とする。
 */
export const OFFICIAL_TRADE_FIELDS: Record<string, FieldCheck> = {
  trade_id: isNumber,
  pair: isString,
  order_id: isNumber,
  side: isString,
  type: isString,
  amount: isString,
  price: isString,
  maker_taker: isString,
  fee_amount_base: isString,
  fee_amount_quote: isString,
  fee_occurred_amount_quote: isString,
  executed_at: isNumber,
};

/**
 * 信用取引を実装しないので常に出さないフィールド。
 *
 * ```
 * position_side | string | undefined | `long` or `short`(only for margin trading)
 * profit_loss | string | undefined | realized profit and loss
 * interest | string | undefined | interest
 * ```
 */
export const UNIMPLEMENTED_TRADE_FIELDS = ["position_side", "profit_loss", "interest"];

/** 本モックが返す注文の type。公式の enum のうち Plan A で実装する 2 値。 */
export const IMPLEMENTED_ORDER_TYPES = ["limit", "market"];

type ShapeResult = { keys: string[]; badTypes: string[] };

/**
 * キー集合と各値の型をまとめて返す。`expect(...).toEqual(...)` の左辺に置くことで、
 * 欠落・余剰・型違いのどれが起きても差分に出る。`toMatchObject` は使わない
 * （ドキュメントに無いキーが素通りするため）。
 */
function shapeOf(actual: Record<string, unknown>, spec: Record<string, FieldCheck>): ShapeResult {
  const badTypes: string[] = [];
  for (const [name, check] of Object.entries(spec)) {
    if (name in actual && !check(actual[name])) {
      badTypes.push(`${name}=${JSON.stringify(actual[name])}`);
    }
  }
  return { keys: Object.keys(actual).sort(), badTypes: badTypes.sort() };
}

/** 注文の比較結果。キー集合と型に加えて `type` の値そのものを持つ。 */
type OrderShapeResult = ShapeResult & { type: unknown };

/**
 * 注文オブジェクトの期待形。`type` と「取消済みか」から、公式の条件どおりに
 * 出るはずのキー集合を組み立てる。
 *
 * `type` の値も比較対象に入れる。キー集合だけを見ると、応答が指値・成行の
 * 取り違えを起こしていても、キーの数が合っていれば通ってしまうため。
 */
export function orderShape(
  actual: Record<string, unknown>,
  expected: { type: "limit" | "market"; canceled: boolean },
): { actual: OrderShapeResult; expected: OrderShapeResult } {
  const keys = Object.keys(OFFICIAL_ORDER_FIELDS);
  // price: type = limit のみ（stop_limit は未実装）。post_only: type = limit のみ。
  if (expected.type === "limit") keys.push("price", "post_only");
  // canceled_at: 公式の応答表に持つのは Cancel order だけ。モックは取消時のみ出す。
  if (expected.canceled) keys.push("canceled_at");
  return {
    actual: {
      type: actual.type,
      ...shapeOf(actual, { ...OFFICIAL_ORDER_FIELDS, ...OFFICIAL_ORDER_CONDITIONAL_FIELDS }),
    },
    expected: { type: expected.type, keys: keys.sort(), badTypes: [] },
  };
}

/** 約定オブジェクトの期待形。条件付きのフィールドは無い。 */
export function tradeShape(actual: Record<string, unknown>): {
  actual: ShapeResult;
  expected: ShapeResult;
} {
  return {
    actual: shapeOf(actual, OFFICIAL_TRADE_FIELDS),
    expected: { keys: Object.keys(OFFICIAL_TRADE_FIELDS).sort(), badTypes: [] },
  };
}
