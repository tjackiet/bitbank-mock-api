import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultFetchCandles, type FetchImpl, isValidCandle } from "../../src/engine/candles.ts";

/**
 * `src/engine/candles.ts`——公開 API のロウソク足を消費する側の検査。
 *
 * **フィクスチャ（`tests/fixtures/candlestick-btc_jpy-1min.json`）の形は公式が正で、
 * 値は架空である。** 出典と、値に出典が無い理由は `tests/fixtures/README.md` に書いてある。
 * 要点だけ再掲すると、構造は bitbank 公式ドキュメント `public-api.md`（固定コミット
 * `0badd68`）の `### Candlestick` 節——応答例 `:324-346`、フィールド表 `:316-320`——に
 * 合わせてあり、`timestamp` は `data` 直下ではなく **`candlestick` 要素の中**（`:341`）に
 * 置く。値は公式の例がプレースホルダ（`"string"` / `0`）でパーサを通らないため、
 * 現実的な数値文字列に差し替えた**架空の値**で、実口座・実市場の観測値ではない。
 *
 * 応答の検証（`type` の一致、`timestamp` の存在）は、**実装に同意するだけの検査にしない**
 * ために、公式から外れた応答を実際に流して落ちることを見る。
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, "../fixtures/candlestick-btc_jpy-1min.json");
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

// 1st row ts in fixture
const T0 = 1735689600000;
const MIN = 60_000;

/** どの URL にも同じ本文を返す fetch。 */
function mockFetch(body: unknown, init: { status?: number } = {}) {
  const status = init.status ?? 200;
  return vi.fn<FetchImpl>(async (_url: string) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

/** URL ごとに別の本文を返す fetch。日跨ぎで日付ごとの応答を配り分けるのに使う。 */
function mockFetchByUrl(bodies: Record<string, unknown>) {
  return vi.fn<FetchImpl>(async (url: string) => {
    const hit = Object.entries(bodies).find(([fragment]) => url.includes(fragment));
    return {
      ok: hit !== undefined,
      status: hit ? 200 : 404,
      json: async () => hit?.[1] ?? {},
    };
  });
}

/** 公式の形の応答を 1 つ組む。`type` と足の中身だけ差し替えたいときに使う。 */
function response(entries: Array<{ type: string; ohlcv: unknown[]; timestamp?: number }>) {
  return {
    success: 1,
    data: {
      candlestick: entries.map((e) => ({
        type: e.type,
        ohlcv: e.ohlcv,
        // 公式は candlestick 要素の必須フィールドとして定義する（`public-api.md:320`）。
        ...(e.timestamp === undefined ? {} : { timestamp: e.timestamp }),
      })),
    },
  };
}

/**
 * 公式の形の足 1 本（`[open, high, low, close, volume, timestamp]`、値は架空）。
 * `base` を動かすと、どの応答・どの要素から来た足かを終値（`base + 5`）で見分けられる。
 */
const row = (ts: number, base = 100) => [
  String(base),
  String(base + 10),
  String(base - 10),
  String(base + 5),
  "1.5",
  ts,
];

describe("isValidCandle", () => {
  const base = { open: 1, high: 1, low: 1, close: 1, vol: 0 };

  const MAX_EPOCH = 8_640_000_000_000_000;
  const JST = 9 * 60 * 60 * 1000;

  it("accepts a candle whose timestamp is inside the Date range", () => {
    expect(isValidCandle({ ...base, timestamp: T0 })).toBe(true);
    // 上側は下流の加算分（JST の 9 時間）の余裕が要る。
    expect(isValidCandle({ ...base, timestamp: MAX_EPOCH - JST })).toBe(true);
    // 下限そのものは Date として有効で、加算しても範囲を出ないので通す（範囲は非対称）。
    expect(isValidCandle({ ...base, timestamp: -MAX_EPOCH })).toBe(true);
    expect(() => new Date(-MAX_EPOCH + MIN).toISOString()).not.toThrow();
  });

  it("rejects a timestamp below the Date range", () => {
    expect(isValidCandle({ ...base, timestamp: -MAX_EPOCH - 1 })).toBe(false);
  });

  // 受理した timestamp は lastTickAt として残り、market モードの足取得で JST を足される。
  // 足して Date の範囲を出ると日付が NaNNaNNaN になり（例外にはならない）、以後の取得が
  // 毎回失敗する。上限はその加算分を引いた値にする。
  it("rejects a timestamp that leaves the Date range after the JST shift", () => {
    const justOver = MAX_EPOCH - JST + 1;
    expect(isValidCandle({ ...base, timestamp: justOver })).toBe(false);
    expect(Number.isNaN(new Date(justOver + JST).getUTCFullYear())).toBe(true);
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
    const fc = defaultFetchCandles({
      baseUrl: "https://example.test",
      fetchImpl: mockFetch(FIXTURE),
    });
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
    const fc = defaultFetchCandles({
      baseUrl: "https://example.test",
      fetchImpl: mockFetch(FIXTURE),
    });
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
    // biome-ignore lint/suspicious/noControlCharactersInRegex: URL に制御文字が残らないことを見るのがこの検査の目的で、範囲指定そのものが意図である
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

  // 日跨ぎは URL が 2 本出るだけでは足りない。**両日の応答をそれぞれ処理して束ねる**ことを見る
  // （日付ごとに違う応答を配って、終値でどちらの日から来た足かを区別する）。
  it("processes each day's response when the range spans two JST dates", async () => {
    const day1 = Date.parse("2026-01-01T01:00:00.000Z"); // 2026-01-01 10:00 JST
    const day2 = Date.parse("2026-01-01T20:00:00.000Z"); // 2026-01-02 05:00 JST
    const fetchImpl = mockFetchByUrl({
      "/1min/20260101": response([{ type: "1min", ohlcv: [row(day1, 100)], timestamp: day1 }]),
      "/1min/20260102": response([{ type: "1min", ohlcv: [row(day2, 200)], timestamp: day2 }]),
    });
    const fc = defaultFetchCandles({ baseUrl: "https://example.test", fetchImpl });
    const r = await fc("btc_jpy", day1, day2);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual([
      { open: 100, high: 110, low: 90, close: 105, vol: 1.5, timestamp: day1 },
      { open: 200, high: 210, low: 190, close: 205, vol: 1.5, timestamp: day2 },
    ]);
  });
});

/**
 * 公式の応答形からの逸脱を落とすことを見る。
 *
 * ここが無いと、スキーマは**実装に同意するだけ**になる。zod の object は既定で余剰キーを
 * 黙って落とすので、宣言していないフィールドは位置が違っても欠けていても気付けない
 * （実際、フィクスチャが `timestamp` を `data` 直下に置いていたのを長く検出できなかった）。
 */
describe("defaultFetchCandles: 公式の応答形の検証", () => {
  const at = Date.parse("2026-01-01T01:00:00.000Z");

  /** 応答の本文を 1 つ流して `Result` を受け取る（範囲は 1 日に収まるので要求は 1 本）。 */
  const run = async (body: unknown) => {
    const fc = defaultFetchCandles({
      baseUrl: "https://example.test",
      fetchImpl: mockFetch(body),
    });
    return fc("btc_jpy", at, at);
  };

  // フィクスチャが公式の形（`public-api.md:328-343`）から外れたらここで落ちる。
  it("keeps the fixture in the official response shape", () => {
    expect(Object.keys(FIXTURE.data)).toEqual(["candlestick"]);
    const entry = FIXTURE.data.candlestick[0];
    expect(Object.keys(entry)).toEqual(["type", "ohlcv", "timestamp"]);
    expect(entry.type).toBe("1min");
    expect(typeof entry.timestamp).toBe("number");
    // ohlcv の先頭 5 要素は公式では全部 string（`public-api.md:319`）。
    expect(entry.ohlcv[0].slice(0, 5).every((v: unknown) => typeof v === "string")).toBe(true);
    expect(typeof entry.ohlcv[0][5]).toBe("number");
  });

  it.each([
    ["candlestick が無い", { success: 1, data: {} }],
    ["ohlcv が無い", { success: 1, data: { candlestick: [{ type: "1min", timestamp: 0 }] } }],
    ["type が無い", { success: 1, data: { candlestick: [{ ohlcv: [row(0)], timestamp: 0 }] } }],
    [
      "ohlcv の要素が 6 つ無い",
      { success: 1, data: { candlestick: [{ type: "1min", ohlcv: [["1", "1"]], timestamp: 0 }] } },
    ],
  ])("rejects a response with a missing required field: %s", async (_name, body) => {
    const r = await run(body);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("candles parse");
  });

  // 公式は candlestick 要素の必須フィールドとして定義する（`public-api.md:320` / `:341`）。
  // 値は使わないが、来ていること自体を確かめる。
  it("rejects a candlestick element without timestamp", async () => {
    const r = await run(response([{ type: "1min", ohlcv: [row(at)] }]));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("candles parse");
  });

  // フィクスチャが誤って取っていた形——`timestamp` を `data` 直下に置く。位置が違えば
  // 要素の中は欠けているので落ちる。
  it("rejects timestamp placed on data instead of the candlestick element", async () => {
    const r = await run({
      success: 1,
      data: { candlestick: [{ type: "1min", ohlcv: [row(at)] }], timestamp: at },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("candles parse");
  });

  // 要求は常に 1min。`BITBANK_PUBLIC_BASE_URL` の差し替え先が別の足を返したとき、
  // 1 分足として約定判定に流さない。
  it("rejects a response whose type is not the requested candle type", async () => {
    const r = await run(response([{ type: "5min", ohlcv: [row(at)], timestamp: at }]));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toContain("candles type mismatch");
      expect(r.error).toContain("want 1min");
      // 応答由来の値はログまで届くので JSON で包んで出す。
      expect(r.error).toContain('got ["5min"]');
    }
  });

  // 複数要素を返し得るかを公式は明記していない。要求した種類に一致する要素を選ぶ
  // （先頭決め打ちだと、並びが変わっただけで 5 分足を 1 分足として扱ってしまう）。
  it("picks the element matching the requested candle type", async () => {
    const r = await run(
      response([
        { type: "5min", ohlcv: [row(at, 900)], timestamp: at },
        { type: "1min", ohlcv: [row(at, 100)], timestamp: at },
      ]),
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual([
      { open: 100, high: 110, low: 90, close: 105, vol: 1.5, timestamp: at },
    ]);
  });

  // 同じ種類が複数来たらどれを採るかが決まらない。黙って 1 つ選ばずに落とす。
  it("rejects duplicated elements of the requested candle type", async () => {
    const r = await run(
      response([
        { type: "1min", ohlcv: [row(at, 100)], timestamp: at },
        { type: "1min", ohlcv: [row(at, 200)], timestamp: at },
      ]),
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain("candles ambiguous: 2 1min elements");
  });

  // 空の配列は「その日の足が無かった」として扱う（従来どおり。不一致にはしない）。
  it("treats an empty candlestick array as no candles", async () => {
    const r = await run(response([]));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual([]);
  });
});
