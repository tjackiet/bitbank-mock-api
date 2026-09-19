import { parseNumericId } from "../engine/state.ts";
import { ErrorCode, type ErrorCodeValue } from "./envelope.ts";

/**
 * 値が「欠落」か。`undefined` / `null` に加えて**空文字も欠落として扱う**。
 * **trim はしない**ので、空白だけの値（`"   "`）は欠落ではなく「不正な値」の側へ落ちる
 * （`pair` なら `pairAssets` が弾いて `40017`）。**実 API も `POST /v1/user/spot/order` に
 * `pair: "   "` を送ると `40017` を返すことを実測した**（2026-09-17）ので、この流れは
 * 本物と一致している。絞り込みパラメータの空白は別経路で、そちらも実 API が空文字と
 * 同じコードを返すことを実測済み。
 *
 * 必須パラメータを持つ互換ルート（`order` の GET / POST、`cancel_order`、
 * `cancel_orders`、`orders_info`）は zod の検査より**先に**これを通し、欠落を
 * パラメータごとの `3000x`（`MISSING_AMOUNT`、`pair` は `MISSING_ASSET` = 30009）で断る。
 * 空文字をここで拾うので、本文側のスキーマ（`src/schemas/requests.ts` の `numStr`）
 * へ空文字は届かない。
 *
 * 絞り込みパラメータは全て任意なのでこの関数を通らない。そちらの空文字は
 * `src/schemas/requests.ts` の `queryNum` が弾き、下の `QUERY_PARAM_CODES` が
 * 引く `4000x` になる。
 */
export function isMissing(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/**
 * 注文 id として読める値か。実 API が `40013` で弾く境界に合わせる。
 *
 * 採番が配る id は `String(seq)` なので、判定は `parseNumericId()`（`src/engine/state.ts`）と
 * 同じ「10 進の数字だけ」に揃える。したがって `true` / `1.5` / 配列 / `null` は読めない。
 * **実測したのは「読めない id」と「読めたが存在しない id」を実 API が分けていること**で
 * （前者 `40013`、後者 `50009`。2026-09-17）、`0` や極端に大きい整数をどちらへ倒すかは
 * 測っていない。どちらもここを通り、存在しないので `50009` へ落ちる。
 */
export function isOrderIdValue(v: unknown): boolean {
  if (typeof v !== "string" && typeof v !== "number") return false;
  return parseNumericId(String(v)) !== null;
}

/**
 * `order_ids` が id の配列になっているか。**空配列は偽**。
 *
 * 実 API は `[]` を `40014` で弾く（2026-09-17 実測）。モックは以前 `success: 1` と
 * 空の一覧を返しており、**注文状態の照合の主経路で成否が逆になっていた**。
 */
export function isOrderIdArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every(isOrderIdValue);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * 絞り込みパラメータの名前。**この配列が扱うパラメータの唯一の出典**で、下の
 * `QUERY_PARAM_CODES` はここに載った名前だけを鍵に取る（`Record<QueryParamName, ...>`）。
 *
 * 並びには意味がある。**複数のパラメータが同時に不正なとき、どれのコードを返すかの優先順**
 * でもある。決めているのはこの配列で、zod のスキーマ定義順ではない（`queryParamErrorCode` が
 * zod の issue を集合にしてからこの順で引くため）。スキーマの並びを逆にしても応答は
 * 変わらないことを実測した。今はたまたま `ActiveOrdersQuerySchema` の並びと一致して
 * いるが、片方だけ並べ替えても挙動は変わらない。
 *
 * **実 API で裏が取れているのは `count` が `end` / `since` より先であることだけ**
 * （2026-09-17、`count=&end=` / `end=&count=` / `since=&count=` の 3 本がすべて `40006`）。
 * `from_id` / `end_id` を含む組み合わせの相対順は未実測なので、この並びは推測を含む。
 * 読み手は複数不正時のコード選択に依存しないこと（`docs/fidelity.md` の「絞り込みパラメータの不正値」節）。
 */
const QUERY_PARAM_ORDER = ["count", "from_id", "end_id", "since", "end"] as const;

type QueryParamName = (typeof QUERY_PARAM_ORDER)[number];

/**
 * 絞り込みパラメータの名前 → 不正値のときに返す error code。
 *
 * **番号は `ErrorCode`（src/routes/envelope.ts）を唯一の出典とする。ここに数値を書かない。**
 * 書き写すと error code の定義元が 2 つになり、`ErrorCode` の側だけを直した変更が
 * 型にもテストにも引っかからないまま wire に出る値だけ元のまま残る。CLAUDE.md が
 * 「エラーは `envelope.ts` の `ErrorCode` にある error code を返す」と定めているので、
 * その規約が実際に成り立つようにする。値を `ErrorCodeValue` で締めてあるため、
 * `ErrorCode` に無い数値を書けば typecheck が落ちる。
 *
 * **鍵は `QueryParamName` で締める。** 以前は `Record<string, ErrorCodeValue>` だったので、
 * 片方の表にだけ名前を足しても typecheck もテストも通った。`QUERY_PARAM_ORDER` に無い名前を
 * ここへ足すと下の走査が一度も当たらず、そのコードは wire に出ないまま `20003` へ落ちる——
 * 実測して確かめた。鍵を締めた今は、足し忘れた側が型で落ちる（両方向とも）。
 *
 * 番号そのものの出典（errors.md のメッセージ名）と実 API の実測は `ErrorCode` の側に
 * 置いてある。この地図が持つのは「どのパラメータがどのコードか」の対応だけである。
 */
const QUERY_PARAM_CODES: Record<QueryParamName, ErrorCodeValue> = {
  count: ErrorCode.INVALID_COUNT,
  end: ErrorCode.INVALID_END,
  end_id: ErrorCode.INVALID_END_ID,
  from_id: ErrorCode.INVALID_FROM_ID,
  since: ErrorCode.INVALID_SINCE,
};

/**
 * zod の失敗から、絞り込みパラメータ固有の error code を選ぶ。該当が無ければ `null` を返し、
 * 呼び出し側が従来どおり `20003` に落とす。
 *
 * **引くのは `QUERY_PARAM_ORDER` の名前だけで、zod が返した名前では引かない。** だから
 * `Object.hasOwn` の防御（`docs/fidelity.md` の「資産キー・ペア名で引く地図」）は要らない。
 * 外から来た名前は `bad.has(name)` の右辺にしか現れず、地図の鍵にはならない。鍵は
 * `QueryParamName` に締めてあるので、`QUERY_PARAM_CODES[name]` は必ず自分のキーに当たる。
 */
export function queryParamErrorCode(paths: Array<PropertyKey | undefined>): ErrorCodeValue | null {
  const bad = new Set(paths.filter((p): p is string => typeof p === "string"));
  for (const name of QUERY_PARAM_ORDER) {
    if (bad.has(name)) return QUERY_PARAM_CODES[name];
  }
  return null;
}
