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
 * 出典: bitbank-api-docs の errors.md（コミット 0badd680）。`"Invalid count."`（40006）、
 * `"Invalid end param."`（40007）、`"Invalid end_id."`（40008）、`"Invalid from_id."`（40009）、
 * `"Invalid trading start time."`（40022）。**汎用の 20003 ではなくこれらを返すことを
 * 実 API で実測している**（docs/fidelity.md の「絞り込みパラメータの不正値」）。
 */
const QUERY_PARAM_CODES: Record<string, number> = {
  count: 40006,
  end: 40007,
  end_id: 40008,
  from_id: 40009,
  since: 40022,
};

/**
 * 不正値のパラメータを見る優先順。複数が同時に不正なとき実 API がどれを返すかは
 * 実測できていないので、モックはこの順で先に当たったものを返す（docs/fidelity.md の同行）。
 */
const QUERY_PARAM_ORDER = ["count", "from_id", "end_id", "since", "end"] as const;

/**
 * zod の失敗から、絞り込みパラメータ固有の error code を選ぶ。該当が無ければ `null` を返し、
 * 呼び出し側が従来どおり `20003` に落とす。
 *
 * パラメータ名は zod のスキーマ由来（未知のキーは落ちる）だが、地図は自分のキーだけを見る
 * （`Object.hasOwn`。docs/fidelity.md の「資産キー・ペア名で引く地図」と同じ扱い）。
 */
export function queryParamErrorCode(paths: Array<PropertyKey | undefined>): number | null {
  const bad = new Set(paths.filter((p): p is string => typeof p === "string"));
  for (const name of QUERY_PARAM_ORDER) {
    if (bad.has(name) && Object.hasOwn(QUERY_PARAM_CODES, name)) return QUERY_PARAM_CODES[name]!;
  }
  return null;
}
