import { describe, expect, it } from "vitest";
import { ErrorCode, err, ok } from "../../src/routes/envelope.ts";

describe("envelope", () => {
  it("wraps success", () => {
    expect(ok({ a: 1 })).toEqual({ success: 1, data: { a: 1 } });
  });

  it("wraps error", () => {
    expect(err(ErrorCode.ORDER_NOT_FOUND)).toEqual({
      success: 0,
      data: { code: 50009 },
    });
  });
});

/**
 * **`60004` を空けたことを型ではなく値で固定する。**
 *
 * `60004`「Order quantity has exceeded the lower threshold.」の公式の意味は**最小数量割れ**で、
 * モックはこれを数量の桁溢れに流用していた。桁溢れは `40001` へ移したので、番号は
 * `/spot/pairs` の `unit_amount` を取得して最小数量の検査を入れるときのために空けてある。
 *
 * このテストが無いと、**誰かが桁や別の失敗に `60004` を充て直しても何も言わない**。
 * `ErrorCode` はこのリポジトリの error code の唯一の定義元なので、ここで見れば
 * wire に `60004` が出る経路も同時に塞げる（`docs/fidelity.md` の「エラーコード」節）。
 */
describe("ErrorCode に載せる番号", () => {
  const values = Object.values(ErrorCode) as number[];

  it("60004 は空けてある（最小数量割れの公式の意味に取ってある）", () => {
    expect(values).not.toContain(60004);
  });

  it("不正値のフィールド別コードが公式の番号どおり載っている", () => {
    // 出典は errors.md（コミット 0badd680）の 104 / 113 / 114 / 116 行。
    expect(ErrorCode.INVALID_ORDER_AMOUNT).toBe(40001);
    expect(ErrorCode.INVALID_ORDER_PRICE).toBe(40020);
    expect(ErrorCode.INVALID_ORDER_SIDE).toBe(40021);
    expect(ErrorCode.INVALID_ORDER_TYPE).toBe(40024);
  });

  it("番号が重複していない", () => {
    expect(new Set(values).size).toBe(values.length);
  });
});
