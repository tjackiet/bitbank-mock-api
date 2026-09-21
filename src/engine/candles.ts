import { fetch as undiciFetch } from "undici";
import { z } from "zod";
import type { FetchCandles, Result } from "./types.ts";

export type FetchImpl = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  timestamp: number;
};

/** JS の `Date` が表現できるエポックミリ秒の上限（下限はこの符号反転）。 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** 日付の切り出しに使う JST のオフセット（`ymdJst`）。足の timestamp の上限にも効く。 */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 足の `timestamp`（および `lastTickAt` に残る時刻）として使える値か。`Date` の表現範囲
 * から下流の加算分を引いた範囲（`-MAX_EPOCH_MS <= timestamp <= MAX_EPOCH_MS −
 * JST_OFFSET_MS`）に収まること。
 *
 * 上側に余裕を取るのは、受け取った timestamp がそのまま下流で足し算されるため。
 * 足し先は 2 つあり、大きいほうの JST オフセット（9 時間）を引く。
 *
 * - `applyFill` の `new Date(candle.timestamp + 1 分).toISOString()` と `runTick` の
 *   `new Date(nowMs).toISOString()`: `Date` の範囲外だと `RangeError` になり、
 *   `POST /_control/tick` が 500 を返す
 * - `ymdJst` の `new Date(ms + JST_OFFSET_MS)`: `POST /_control/tick` が受けた
 *   timestamp は `lastTickAt` として残り、`BITBANK_MOCK_FILL_MODE=market` の
 *   `SessionStore.tick()` がそれを足の取得範囲の起点に使う。範囲外だと `Invalid Date`
 *   になり、`getUTCFullYear()` 等が `NaN` を返して日付が `NaNNaNNaN` の URL になる
 *   （例外にはならず、足の取得が毎回失敗し続ける）
 *
 * 下限そのものは `Date` として有効で、下流の加算でも範囲を出ないので、範囲は非対称。
 *
 * これは `Date` の表現範囲だけから決まる制約で、「実時間からどれだけ先を許すか」とは
 * 別物。後者は `/_control/` の中だけの制約として `src/routes/control.ts` の
 * `MAX_CLOCK_AHEAD_MS` が持ち、この範囲の内側にある。
 */
export function isValidCandleTimestamp(timestamp: number): boolean {
  if (!Number.isFinite(timestamp)) return false;
  return timestamp >= -MAX_EPOCH_MS && timestamp <= MAX_EPOCH_MS - JST_OFFSET_MS;
}

/**
 * 足として使える値か。有限かつ `0 < low <= open <= high` かつ `low <= close <= high` で、
 * `timestamp` が `isValidCandleTimestamp` の範囲に収まること。
 */
export function isValidCandle(c: Candle): boolean {
  const { open, high, low, close, vol, timestamp } = c;
  if (![open, high, low, close, vol].every((n) => Number.isFinite(n))) return false;
  if (!isValidCandleTimestamp(timestamp)) return false;
  if (!(open > 0 && high > 0 && low > 0 && close > 0)) return false;
  return low <= open && open <= high && low <= close && close <= high;
}

/**
 * 公式は `ohlcv` の先頭 5 要素を全部 string と定義する（`public-api.md:319`）。ここで
 * `number | string` を受けているのは**意図した緩さ**で、公式より広い。消費側が緩いぶんには
 * 実害が無く、公式どおりの string だけの応答もそのまま通る。狭めない。
 */
const numStr = z.union([z.number(), z.string().transform((s) => Number(s))]);

/**
 * 公開 API `GET /{pair}/candlestick/{candle-type}/{YYYYMMDD}` の応答（`data` の中身）。
 * 公式のフィールド表（`public-api.md:316-320`）と応答例（`:324-346`）の両方に合わせる。
 *
 * `timestamp` は公式が定義する candlestick 要素の必須フィールドで（`public-api.md:320`、
 * "published at unix timestamp (milliseconds)"）、**要素の中**にある（`:341`）。
 * **値はどこでも使わない**——約定判定に要るのは `ohlcv` だけである。それでも宣言するのは、
 * **公式の必須フィールドが来ていることを確かめる**ためで、zod の object は既定で余剰キーを
 * 黙って落とすので、宣言しない限り欠落も位置違い（`data` 直下に置いた応答など）も検出できない。
 */
const CandlestickSchema = z.object({
  candlestick: z.array(
    z.object({
      type: z.string(),
      ohlcv: z.array(z.tuple([numStr, numStr, numStr, numStr, numStr, z.number()])),
      timestamp: z.number(),
    }),
  ),
});

/** 応答の `candlestick` の 1 要素（1 つの足の種類ぶん）。 */
type CandlestickEntry = z.infer<typeof CandlestickSchema>["candlestick"][number];

/**
 * 要求する足の種類。公式の enum（`public-api.md:307`）のうちモックが使うのは 1 分足だけで、
 * `runTick` も 1 分足を前提に約定を判定する。URL の組み立てと応答の `type` の検査で同じ値を
 * 使い、要求と検査がずれないようにする。
 */
const CANDLE_TYPE = "1min";

const DEFAULT_BASE_URL = "https://public.bitbank.cc";

function ymdJst(ms: number): string {
  const d = new Date(ms + JST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export type CandlesOptions = {
  baseUrl?: string;
  fetchImpl?: FetchImpl;
};

export function defaultFetchCandles(opts: CandlesOptions = {}): FetchCandles {
  const baseUrl = opts.baseUrl ?? process.env.BITBANK_PUBLIC_BASE_URL ?? DEFAULT_BASE_URL;
  const fetchImpl: FetchImpl = opts.fetchImpl ?? (undiciFetch as unknown as FetchImpl);
  return async (pair, fromMs, toMs) => {
    const dates = new Set<string>([ymdJst(fromMs), ymdJst(toMs)]);
    const all: Candle[] = [];
    for (const d of [...dates].sort()) {
      const r = await fetchOneDay(fetchImpl, baseUrl, pair, d);
      if (!r.success) return r;
      for (const c of r.data) {
        if (c.timestamp >= fromMs && c.timestamp <= toMs) all.push(c);
      }
    }
    return { success: true, data: all };
  };
}

async function fetchOneDay(
  fetchImpl: FetchImpl,
  baseUrl: string,
  pair: string,
  dateStr: string,
): Promise<Result<Candle[]>> {
  // pair は利用者の入力に由来する。素の文字列を埋めると `..` がベース URL のパス接頭辞を
  // 脱出し、`?` / `#` が以降をクエリ・フラグメントに変えてしまう。1 セグメントとして
  // エンコードして、区切り文字も制御文字も文字そのものとして送る。
  // 入口（src/engine/state.ts の pairAssets）でも文字種を弾いているが、engine を直接
  // 呼ぶ経路に備えてここでも守る。dateStr は ymdJst が作る数字だけなのでそのまま。
  const url = `${baseUrl}/${encodeURIComponent(pair)}/candlestick/${CANDLE_TYPE}/${dateStr}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return { success: false, error: `candles HTTP ${res.status} for ${url}` };
    const json = (await res.json()) as { success?: number; data?: unknown };
    if (json.success !== 1) return { success: false, error: `candles non-success for ${url}` };
    const parsed = CandlestickSchema.safeParse(json.data);
    if (!parsed.success) return { success: false, error: `candles parse: ${parsed.error.message}` };
    const picked = pickCandlestick(parsed.data.candlestick, url);
    if (!picked.success) return picked;
    const ohlcv = picked.data;
    return {
      success: true,
      data: ohlcv.map(([open, high, low, close, vol, timestamp]) => ({
        open,
        high,
        low,
        close,
        vol,
        timestamp,
      })),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `candles fetch failed: ${msg}` };
  }
}

/**
 * 応答の `candlestick` から、要求した種類（`CANDLE_TYPE`）の足を取り出す。
 *
 * `type` を確かめるのは、`BITBANK_PUBLIC_BASE_URL` で取得先を差し替えられるためである。
 * 確かめないと、差し替え先が返した 5 分足をそのまま 1 分足として約定判定に流し込める。
 *
 * **`candlestick` が複数要素を返し得るかは公式が明記していない**（`public-api.md:328-343`
 * の応答例は 1 要素で、`type` の enum は定義されているが要素数には触れていない）。そこで
 * 「1 要素であること」は要求せず、**要求した種類に一致する要素を選ぶ**ことにした。公式が
 * 将来ほかの種類を並べて返しても、こちらは要求した足だけを見て動き続ける——消費側が緩いのは
 * `numStr` と同じ筋で、実害が無い。ただし同じ種類が複数来たときはどれを採るかが決まらないので、
 * 黙って 1 つを採らずに失敗させる。
 *
 * 空の `candlestick` は「その種類の足が無かった」として空の足を返し、`CANDLE_TYPE` が
 * 無いことを不一致として扱わない。空の配列を返し得るかも公式は明記していない。ここは
 * 従来どおりの扱いで、変えるなら別に判断する。
 *
 * 応答由来の `type` はログ（`SessionStore.tick()` の warn）まで届くので、JSON で包んで出す。
 */
function pickCandlestick(
  candlestick: CandlestickEntry[],
  url: string,
): Result<CandlestickEntry["ohlcv"]> {
  if (candlestick.length === 0) return { success: true, data: [] };
  const [matched, ...duplicates] = candlestick.filter((c) => c.type === CANDLE_TYPE);
  if (!matched) {
    const types = JSON.stringify(candlestick.map((c) => c.type));
    return {
      success: false,
      error: `candles type mismatch for ${url}: want ${CANDLE_TYPE}, got ${types}`,
    };
  }
  if (duplicates.length > 0) {
    return {
      success: false,
      error: `candles ambiguous: ${duplicates.length + 1} ${CANDLE_TYPE} elements for ${url}`,
    };
  }
  return { success: true, data: matched.ohlcv };
}
