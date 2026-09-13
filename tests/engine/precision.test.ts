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

  it("formats amounts and prices to fixed decimals", () => {
    expect(formatAmount("btc_jpy", 0.001)).toBe("0.0010");
    expect(formatPrice("btc_jpy", 5_000_000.4)).toBe("5000000");
  });
});
