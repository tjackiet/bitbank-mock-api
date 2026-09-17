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

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

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
 * 番号そのものの出典（errors.md のメッセージ名）と実 API の実測は `ErrorCode` の側に
 * 置いてある。この地図が持つのは「どのパラメータがどのコードか」の対応だけである。
 */
const QUERY_PARAM_CODES: Record<string, ErrorCodeValue> = {
  count: ErrorCode.INVALID_COUNT,
  end: ErrorCode.INVALID_END,
  end_id: ErrorCode.INVALID_END_ID,
  from_id: ErrorCode.INVALID_FROM_ID,
  since: ErrorCode.INVALID_SINCE,
};

/**
 * 不正値のパラメータを見る優先順。複数が同時に不正なとき実 API がどれを返すかは
 * 実測できていないので、モックはこの順で先に当たったものを返す（docs/fidelity.md の同行）。
 */
/**
 * 複数のパラメータが同時に不正なとき、どれのコードを返すかの優先順。
 *
 * **決めているのはこの配列で、zod のスキーマ定義順ではない**（`queryParamErrorCode` が
 * zod の issue を集合にしてからこの順で引くため）。スキーマの並びを逆にしても応答は
 * 変わらないことを実測した。今はたまたま `ActiveOrdersQuerySchema` の並びと一致して
 * いるが、片方だけ並べ替えても挙動は変わらない。
 *
 * **実 API で裏が取れているのは `count` が `end` / `since` より先であることだけ**
 * （2026-09-17、`count=&end=` / `end=&count=` / `since=&count=` の 3 本がすべて `40006`）。
 * `from_id` / `end_id` を含む組み合わせの相対順は未実測なので、この並びは推測を含む。
 * Nyx は複数不正時のコード選択に依存しないこと（docs/fidelity.md の同行）。
 */
const QUERY_PARAM_ORDER = ["count", "from_id", "end_id", "since", "end"] as const;

/**
 * zod の失敗から、絞り込みパラメータ固有の error code を選ぶ。該当が無ければ `null` を返し、
 * 呼び出し側が従来どおり `20003` に落とす。
 *
 * パラメータ名は zod のスキーマ由来（未知のキーは落ちる）だが、地図は自分のキーだけを見る
 * （`Object.hasOwn`。docs/fidelity.md の「資産キー・ペア名で引く地図」と同じ扱い）。
 */
export function queryParamErrorCode(
  paths: Array<PropertyKey | undefined>,
): ErrorCodeValue | null {
  const bad = new Set(paths.filter((p): p is string => typeof p === "string"));
  for (const name of QUERY_PARAM_ORDER) {
    if (bad.has(name) && Object.hasOwn(QUERY_PARAM_CODES, name)) return QUERY_PARAM_CODES[name]!;
  }
  return null;
}
