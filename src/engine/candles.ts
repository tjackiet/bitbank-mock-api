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

/** 足 1 本の長さ。`applyFill` が約定時刻を `timestamp + 1 分` で作る。 */
const CANDLE_SPAN_MS = 60_000;

/**
 * 足として使える値か。有限かつ `0 < low <= open <= high` かつ `low <= close <= high` で、
 * `timestamp` が `Date` の表現範囲に収まること。
 *
 * timestamp の上限を見るのは、有限でも `Date` の範囲外（`1e20` など）の値が
 * `runTick` の `new Date(nowMs).toISOString()` と `applyFill` の
 * `new Date(candle.timestamp + 1 分).toISOString()` で `RangeError` になり、
 * `POST /_control/tick` が 500 を返すため。1 分後も範囲に収まる値だけを通す。
 */
export function isValidCandle(c: Candle): boolean {
  const { open, high, low, close, vol, timestamp } = c;
  if (![open, high, low, close, vol, timestamp].every((n) => Number.isFinite(n))) return false;
  if (Math.abs(timestamp) > MAX_EPOCH_MS - CANDLE_SPAN_MS) return false;
  if (!(open > 0 && high > 0 && low > 0 && close > 0)) return false;
  return low <= open && open <= high && low <= close && close <= high;
}

const numStr = z.union([z.number(), z.string().transform((s) => Number(s))]);

const CandlestickSchema = z.object({
  candlestick: z.array(
    z.object({
      type: z.string(),
      ohlcv: z.array(z.tuple([numStr, numStr, numStr, numStr, numStr, z.number()])),
    }),
  ),
});

const DEFAULT_BASE_URL = "https://public.bitbank.cc";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

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
  const url = `${baseUrl}/${encodeURIComponent(pair)}/candlestick/1min/${dateStr}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return { success: false, error: `candles HTTP ${res.status} for ${url}` };
    const json = (await res.json()) as { success?: number; data?: unknown };
    if (json.success !== 1) return { success: false, error: `candles non-success for ${url}` };
    const parsed = CandlestickSchema.safeParse(json.data);
    if (!parsed.success) return { success: false, error: `candles parse: ${parsed.error.message}` };
    const ohlcv = parsed.data.candlestick[0]?.ohlcv ?? [];
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
