import { describe, expect, it } from "vitest";
import { fitsDigits, formatAmount, formatPrice, precisionOf } from "../../src/engine/precision.ts";

describe("pair precision", () => {
  it("uses 4 amount digits and 0 price digits for btc_jpy", () => {
    expect(precisionOf("btc_jpy")).toEqual({ amountDigits: 4, priceDigits: 0 });
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
