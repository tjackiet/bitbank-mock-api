import type { Candle } from "./candles.ts";

export type Result<T> = { success: true; data: T } | { success: false; error: string };

export interface Logger {
  warn(msg: string): void;
  info(msg: string): void;
}

export const noopLogger: Logger = {
  warn: () => {},
  info: () => {},
};

export type FetchCandles = (
  pair: string,
  fromMs: number,
  toMs: number,
) => Promise<Result<Candle[]>>;
