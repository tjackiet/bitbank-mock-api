import { describe, expect, it } from "vitest";
import {
  ActiveOrdersQuerySchema,
  CreateOrderRequestSchema,
  TradeHistoryQuerySchema,
} from "../../src/schemas/requests.ts";

/**
 * リクエストスキーマの境界を、ルートを通さずに直接見る。
 *
 * **ルート側のテストと役割が違う。** `tests/routes/active-orders.test.ts` などが見るのは
 * 「どの error code が wire に出るか」で、そちらが wire 上の契約である。ここで見るのは
 * **スキーマが値を受けるか落とすか**という一段手前の判定で、`queryNum` の preprocess が
 * 何を落としているかを、経路の数だけ繰り返さずに 1 箇所で固定する。
 *
 * `queryNum` / `queryCount` は export していないので、それらを使う
 * `ActiveOrdersQuerySchema` / `TradeHistoryQuerySchema` 越しに見る。
 */
describe("クエリの数値（queryNum / queryCount）", () => {
  const parse = (query: Record<string, unknown>) =>
    ActiveOrdersQuerySchema.safeParse({ pair: "btc_jpy", ...query });

  it("数値の文字列は受ける", () => {
    const r = parse({ count: "5", since: "1700000000000", end_id: "0" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.count).toBe(5);
      expect(r.data.since).toBe(1_700_000_000_000);
      // `end_id` は `queryNum` なので 0 も通る（正の整数を要求するのは `count` だけ）。
      expect(r.data.end_id).toBe(0);
    }
  });

  it("未指定は通る（絞り込みは任意）", () => {
    const r = parse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.count).toBeUndefined();
  });

  /**
   * `z.coerce.number()` は `""` を `0` にする。そのまま使うと `?end=` が
   * 「`0` 以下だけを残す」絞り込みになり、`success: 1` で常に空配列を返していた。
   */
  it("空文字は落とす（`0` として扱わない）", () => {
    for (const key of ["count", "from_id", "end_id", "since", "end"]) {
      expect(parse({ [key]: "" }).success, key).toBe(false);
    }
  });

  /**
   * `Number()` は前後の空白を読み飛ばすので、空白だけの値も `0` になって空文字と同じ抜け方をする。
   * `String#trim()` が落とす文字の集合は `Number()` が読み飛ばす集合と同じなので、
   * `trim()` の結果が空なら弾けば過不足なく閉じる——それをここで確かめる。
   */
  it("空白だけの値も落とす", () => {
    for (const v of [" ", "\t", "\n", " ", " \t\n "]) {
      expect(parse({ end: v }).success, JSON.stringify(v)).toBe(false);
    }
  });

  /**
   * 同名のクエリが 2 本来ると値は配列になる。`Number(["1","2"])` は `NaN` なので
   * 結果は落とす側で変わらないが、**要素数を数えずに数値へ強制しない**という姿勢を型で示す。
   * wire 上どの code になるかは `docs/fidelity.md` の「同じ名前で複数来る値」節と
   * `tests/routes/active-orders.test.ts` が持つ。
   */
  it("同名で複数来た値（配列）は落とす", () => {
    expect(parse({ count: ["1", "2"] }).success).toBe(false);
    expect(parse({ since: ["1"] }).success).toBe(false);
    // 1 要素でも、文字列でない時点で落とす。
    expect(parse({ end: 1 }).success).toBe(false);
  });

  it("数にならない値と非有限は落とす", () => {
    for (const v of ["abc", "1e999", "NaN", "Infinity"]) {
      expect(parse({ since: v }).success, v).toBe(false);
    }
  });

  it("`count` は正の整数だけを受ける", () => {
    for (const v of ["0", "-1", "1.5"]) {
      expect(parse({ count: v }).success, v).toBe(false);
    }
    expect(parse({ count: "1" }).success).toBe(true);
  });

  it("`trade_history` の `order` は asc / desc だけを受ける", () => {
    const base = { pair: "btc_jpy" };
    expect(TradeHistoryQuerySchema.safeParse({ ...base, order: "asc" }).success).toBe(true);
    expect(TradeHistoryQuerySchema.safeParse({ ...base, order: "desc" }).success).toBe(true);
    expect(TradeHistoryQuerySchema.safeParse({ ...base, order: "ASC" }).success).toBe(false);
    expect(TradeHistoryQuerySchema.safeParse({ ...base, order: "" }).success).toBe(false);
  });
});

/**
 * 本文側の数値（`numStr`）はクエリ側と規則が違う。
 *
 * **空文字をここで落としていない**のは、欠落と空文字を `isMissing()` が先に `3000x` で
 * 拾うので、ここへ来ないためである（`src/schemas/requests.ts` の `queryNum` の項）。
 * 規則が違うこと自体を固定しておかないと、片方に寄せる変更が黙って通る。
 */
describe("本文の数値（numStr）", () => {
  const base = { pair: "btc_jpy", side: "buy", type: "limit" } as const;

  it("数値でも文字列でも受ける", () => {
    expect(CreateOrderRequestSchema.safeParse({ ...base, amount: "0.001", price: "5000000" }).success).toBe(
      true,
    );
    expect(CreateOrderRequestSchema.safeParse({ ...base, amount: 0.001, price: 5_000_000 }).success).toBe(
      true,
    );
  });

  it("`amount` は 0 以下を落とす", () => {
    for (const v of ["0", "-1"]) {
      expect(CreateOrderRequestSchema.safeParse({ ...base, amount: v, price: "1" }).success, v).toBe(
        false,
      );
    }
  });

  it("非有限を落とす", () => {
    expect(CreateOrderRequestSchema.safeParse({ ...base, amount: "1e999", price: "1" }).success).toBe(
      false,
    );
  });

  it("`price` は任意（成行のため）", () => {
    expect(
      CreateOrderRequestSchema.safeParse({ ...base, type: "market", amount: "0.001" }).success,
    ).toBe(true);
  });
});
