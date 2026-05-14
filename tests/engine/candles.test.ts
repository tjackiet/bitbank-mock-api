import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultFetchCandles, type FetchImpl } from "../../src/engine/candles.ts";

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
