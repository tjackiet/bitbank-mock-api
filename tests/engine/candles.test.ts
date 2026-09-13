import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultFetchCandles, isValidCandle, type FetchImpl } from "../../src/engine/candles.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, "../fixtures/candlestick-btc_jpy-1min.json");
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

// 1st row ts in fixture
const T0 = 1735689600000;
const MIN = 60_000;

function mockFetch(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  return vi.fn<FetchImpl>(async (_url: string) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe("isValidCandle", () => {
  const base = { open: 1, high: 1, low: 1, close: 1, vol: 0 };

  it("accepts a candle whose timestamp is inside the Date range", () => {
    expect(isValidCandle({ ...base, timestamp: T0 })).toBe(true);
    // 上側は足 1 本分の余裕が要る（applyFill が timestamp + 1 分を Date にする）。
    expect(isValidCandle({ ...base, timestamp: 8_640_000_000_000_000 - MIN })).toBe(true);
    // 下限そのものは Date として有効で、1 分後も範囲内なので通す（範囲は非対称）。
    expect(isValidCandle({ ...base, timestamp: -8_640_000_000_000_000 })).toBe(true);
    expect(() => new Date(-8_640_000_000_000_000 + MIN).toISOString()).not.toThrow();
  });

  it("rejects a timestamp below the Date range", () => {
    expect(isValidCandle({ ...base, timestamp: -8_640_000_000_000_001 })).toBe(false);
  });

  // 有限でも Date の範囲外の値は、lastTickAt や約定時刻の toISOString() で RangeError になる。
  it.each([[1e20], [8_640_000_000_000_000], [8_640_000_000_000_000 - MIN + 1], [-1e20]])(
    "rejects a timestamp outside the Date range: %s",
    (timestamp) => {
      expect(isValidCandle({ ...base, timestamp })).toBe(false);
      expect(() => new Date(timestamp + MIN).toISOString()).toThrow(RangeError);
    },
  );

  it("still rejects non-finite and inconsistent candles", () => {
    expect(isValidCandle({ ...base, timestamp: Number.NaN })).toBe(false);
    expect(isValidCandle({ ...base, low: 0, timestamp: T0 })).toBe(false);
    expect(isValidCandle({ ...base, high: 0.5, timestamp: T0 })).toBe(false);
  });
});

describe("defaultFetchCandles", () => {
  it("parses bitbank candlestick response and returns Candle[]", async () => {
    const fc = defaultFetchCandles({ baseUrl: "https://example.test", fetchImpl: mockFetch(FIXTURE) });
    const r = await fc("btc_jpy", T0, T0 + 2 * MIN);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toHaveLength(3);
    expect(r.data[0]).toEqual({
      open: 5_000_000,
      high: 5_005_000,
      low: 4_998_000,
      close: 5_002_000,
      vol: 0.1234,
      timestamp: T0,
    });
  });

  it("filters candles outside [fromMs, toMs]", async () => {
    const fc = defaultFetchCandles({ baseUrl: "https://example.test", fetchImpl: mockFetch(FIXTURE) });
    const r = await fc("btc_jpy", T0 + MIN, T0 + MIN);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toHaveLength(1);
    expect(r.data[0].timestamp).toBe(T0 + MIN);
  });

  it("issues one request per JST date in range", async () => {
    const fetchImpl = mockFetch(FIXTURE);
    const fc = defaultFetchCandles({ baseUrl: "https://example.test", fetchImpl });
    // span 2 JST days
    const day1 = Date.parse("2026-01-01T01:00:00.000Z"); // 2026-01-01 JST
    const day2 = Date.parse("2026-01-01T20:00:00.000Z"); // 2026-01-02 JST
    await fc("btc_jpy", day1, day2);
    const urls = fetchImpl.mock.calls.map((c) => c[0]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/btc_jpy/candlestick/1min/20260101");
    expect(urls[1]).toContain("/btc_jpy/candlestick/1min/20260102");
  });

  // pair はパスセグメント 1 つとしてエスケープする。入口（pairAssets）で弾いているが、
  // engine を直接呼ぶ経路に備えた 2 層目。区切り文字がパスの構造に効かないことを見る。
  it.each([
    ["../../admin_jpy", "/..%2F..%2Fadmin_jpy/candlestick/1min/20260101"],
    ["btc?a=1_jpy", "/btc%3Fa%3D1_jpy/candlestick/1min/20260101"],
    ["btc#frag_jpy", "/btc%23frag_jpy/candlestick/1min/20260101"],
  ])("escapes %s into a single path segment", async (pair, expectedPath) => {
    const fetchImpl = mockFetch(FIXTURE);
    const fc = defaultFetchCandles({ baseUrl: "https://example.test", fetchImpl });
    const at = Date.parse("2026-01-01T01:00:00.000Z");
    await fc(pair, at, at);
    expect(fetchImpl.mock.calls).toHaveLength(1);
    const url = new URL(fetchImpl.mock.calls[0][0]);
    // `..` でベース URL の外へ出ず、`?` / `#` で以降がクエリ・フラグメントにならない
    expect(url.origin).toBe("https://example.test");
    expect(url.pathname).toBe(expectedPath);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  it("escapes control characters in the pair", async () => {
    const fetchImpl = mockFetch(FIXTURE);
    const fc = defaultFetchCandles({ baseUrl: "https://example.test", fetchImpl });
    const at = Date.parse("2026-01-01T01:00:00.000Z");
    await fc("btc\r\nx_jpy", at, at);
    const raw = fetchImpl.mock.calls[0][0];
    expect(raw).not.toMatch(/[\u0000-\u001f]/);
    expect(new URL(raw).pathname).toBe("/btc%0D%0Ax_jpy/candlestick/1min/20260101");
  });

  it("leaves a well-formed pair unescaped", async () => {
    const fetchImpl = mockFetch(FIXTURE);
    const fc = defaultFetchCandles({ baseUrl: "https://example.test", fetchImpl });
    const at = Date.parse("2026-01-01T01:00:00.000Z");
    await fc("foo_jpy", at, at);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://example.test/foo_jpy/candlestick/1min/20260101",
    );
  });

  it("returns failure on HTTP error", async () => {
    const fc = defaultFetchCandles({
      baseUrl: "https://example.test",
      fetchImpl: mockFetch({}, { status: 500 }),
    });
    const r = await fc("btc_jpy", T0, T0 + MIN);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("HTTP 500");
  });

  it("returns failure on success: 0 envelope", async () => {
    const fc = defaultFetchCandles({
      baseUrl: "https://example.test",
      fetchImpl: mockFetch({ success: 0, data: { code: 10000 } }),
    });
    const r = await fc("btc_jpy", T0, T0 + MIN);
    expect(r.success).toBe(false);
  });

  it("returns failure when fetch itself throws", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => {
      throw new Error("network down");
    });
    const fc = defaultFetchCandles({ baseUrl: "https://example.test", fetchImpl });
    const r = await fc("btc_jpy", T0, T0 + MIN);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("network down");
  });
});
