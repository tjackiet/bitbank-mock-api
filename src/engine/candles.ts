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
  const url = `${baseUrl}/${pair}/candlestick/1min/${dateStr}`;
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
