import { afterEach } from "vitest";
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
  const close = async () => {
    await fastify.close();
  };
  return { fastify, store, close };
}

// describe ブロック内で呼ぶと、build() で作ったサーバを afterEach で自動 close する。
export function setupBuildTestServer() {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });
  return async (
    state: PaperState = buildState(),
    candlesByPair: Record<string, Candle[]> = {},
  ) => {
    const r = await buildTestServer(state, candlesByPair);
    cleanups.push(r.close);
    return r;
  };
}
