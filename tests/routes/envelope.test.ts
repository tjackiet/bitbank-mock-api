import { describe, expect, it } from "vitest";
import { err, ErrorCode, ok } from "../../src/routes/envelope.ts";

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
