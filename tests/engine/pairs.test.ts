import { describe, expect, it } from "vitest";
import { isKnownPair, OFFICIAL_PAIRS } from "../../src/engine/pairs.ts";
import { pairAssets } from "../../src/engine/state.ts";

/**
 * 表の中身が公式 `pairs.md` の転記であることを見る。
 *
 * **正しさの根拠はこのテストではなく公式ドキュメント**
 * （https://github.com/bitbankinc/bitbank-api-docs/blob/master/pairs.md）で、
 * ここが押さえるのは転記ミスと、うっかりした編集で表が崩れることだけである。
 * 期待値は 2026-09-17 時点の公式表から数えたもので、bitbank が上場・上場廃止を
 * すれば当然変わる。そのときは表と一緒にここも更新する。
 */
describe("OFFICIAL_PAIRS", () => {
  it("公式表と同じ 62 ペアを持ち、重複しない", () => {
    expect(OFFICIAL_PAIRS).toHaveLength(62);
    expect(new Set(OFFICIAL_PAIRS.map((p) => p.pair)).size).toBe(62);
  });

  it("どのペア名も pairAssets が受け付ける形をしている", () => {
    for (const { pair } of OFFICIAL_PAIRS) {
      expect(pairAssets(pair), pair).not.toBeNull();
    }
  });

  // 「照会できるペア」と「発注できるペア」が別の集合であること。公式表の
  // "Order suspended flag (delisted)" 列がそのまま 18 ペアで立っている。
  it("発注停止は 18 ペアで、_btc 全部と mkr / matic / rndr の jpy ペアである", () => {
    const suspended = OFFICIAL_PAIRS.filter((p) => p.orderSuspended).map((p) => p.pair);
    expect(suspended).toHaveLength(18);
    expect(suspended.filter((p) => p.endsWith("_btc"))).toHaveLength(15);
    expect(suspended.filter((p) => p.endsWith("_jpy"))).toEqual([
      "mkr_jpy",
      "matic_jpy",
      "rndr_jpy",
    ]);
  });

  it("_btc は 15 ペアすべてが発注停止で、_jpy は 47 ペア中 44 が発注できる", () => {
    const btc = OFFICIAL_PAIRS.filter((p) => p.pair.endsWith("_btc"));
    const jpy = OFFICIAL_PAIRS.filter((p) => p.pair.endsWith("_jpy"));
    expect(btc).toHaveLength(15);
    expect(btc.every((p) => p.orderSuspended)).toBe(true);
    expect(jpy).toHaveLength(47);
    expect(jpy.filter((p) => !p.orderSuspended)).toHaveLength(44);
    // 62 ペアは _jpy と _btc で尽きる（別の quote 資産が増えたら気づけるように）。
    expect(btc.length + jpy.length).toBe(OFFICIAL_PAIRS.length);
  });

  it("btc_jpy は一覧にあり、発注停止ではない", () => {
    expect(OFFICIAL_PAIRS[0]).toEqual({ pair: "btc_jpy", orderSuspended: false });
  });
});

describe("isKnownPair", () => {
  it("一覧にあるペアだけを通す", () => {
    expect(isKnownPair("btc_jpy")).toBe(true);
    // 発注停止のペアも「照会できるペア」なので一覧にはある。
    expect(isKnownPair("xrp_btc")).toBe(true);
    expect(isKnownPair("foo_jpy")).toBe(false);
    expect(isKnownPair("xxx_yyy")).toBe(false);
  });

  // 一覧は Set で引く。継承したキーを掴まないこと（ペア名は利用者の入力でもある）。
  it("Object.prototype のキーや形の壊れた入力を通さない", () => {
    expect(isKnownPair("constructor")).toBe(false);
    expect(isKnownPair("toString")).toBe(false);
    expect(isKnownPair("__proto__")).toBe(false);
    expect(isKnownPair("")).toBe(false);
    expect(isKnownPair("BTC_JPY")).toBe(false);
    expect(isKnownPair("btc_jpy ")).toBe(false);
  });
});
