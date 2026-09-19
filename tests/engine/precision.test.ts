import { describe, expect, it } from "vitest";
import { fitsDigits, formatAmount, formatPrice, precisionOf } from "../../src/engine/precision.ts";

describe("pair precision", () => {
  it("uses 4 amount digits and 0 price digits for btc_jpy", () => {
    expect(precisionOf("btc_jpy")).toEqual({ amountDigits: 4, priceDigits: 0 });
  });

  // ペア名は state ファイル由来でもあるので、Object.prototype が持つ名前で引かれ得る。
  // 素の `[pair] ?? 既定` だと継承値（関数）が返り、桁として使われて出力が壊れる。
  it("falls back to the default digits for a pair named like an Object.prototype key", () => {
    expect(precisionOf("constructor")).toEqual({ amountDigits: 4, priceDigits: 0 });
    expect(formatAmount("constructor", 0.001)).toBe("0.0010");
  });

  it("accepts amounts that fit the pair digits", () => {
    expect(fitsDigits(0.001, 4)).toBe(true);
    expect(fitsDigits(0.1 + 0.2, 4)).toBe(true);
    expect(fitsDigits(5_000_000, 0)).toBe(true);
    expect(fitsDigits(0.00001, 4)).toBe(false);
    expect(fitsDigits(5_000_000.1, 0)).toBe(false);
  });

  /**
   * 許容幅（`DIGIT_FIT_EPS`）の**両側**を見る。
   *
   * 幅は倍精度の塵を吸うためのもので、桁そのものの緩和ではない。ところが上の反例は
   * どちらもスケール後の差が `0.1` あり、**幅を 1e-8 から 1e-2 へ 100 万倍に緩めても
   * 落ちなかった**（実測）。`0.1 + 0.2` の側も差は 4.5e-13 で、幅を 1e-12 へ締めても通る。
   * つまり幅はどちらの向きへ動かしても検査に当たらなかった。
   *
   * 幅が緩めば「小数 5 桁の注文が受理される」、締まれば「普通の注文が `60004` で断られる」。
   * 両側を挟んでおく。
   */
  it("holds both sides of the dust tolerance", () => {
    // スケール後 10.001 → 整数との差 1e-3。塵ではなく 5 桁目を持っている値なので断る。
    expect(fitsDigits(0.0010001, 4)).toBe(false);
    // スケール後 10.0000000001 → 差 1e-10。倍精度の塵の側なので通す。
    expect(fitsDigits(0.001 + 1e-14, 4)).toBe(true);
  });

  it("formats amounts and prices to fixed decimals", () => {
    expect(formatAmount("btc_jpy", 0.001)).toBe("0.0010");
    expect(formatPrice("btc_jpy", 5_000_000.4)).toBe("5000000");
  });
});
