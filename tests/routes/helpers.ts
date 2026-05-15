import type { Candle } from "../../src/engine/candles.ts";
import type { FetchCandles } from "../../src/engine/types.ts";
import { buildState } from "../engine/helpers.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import type { PaperState } from "../../src/engine/state.ts";

export function stubFetchCandles(byPair: Record<string, Candle[]>): FetchCandles {
  return async (pair, fromMs, toMs) => {
    const data = (byPair[pair] ?? []).filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
    return { success: true, data };
  };
}

export async function buildTestServer(
  state: PaperState = buildState(),
  candlesByPair: Record<string, Candle[]> = {},
) {
  const store = new SessionStore(state, {
    path: null,
    fetchCandles: stubFetchCandles(candlesByPair),
  });
  const fastify = await buildServer({ store, logger: false });
  return { fastify, store };
}
