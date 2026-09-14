import { afterEach } from "vitest";
import type { Candle } from "../../src/engine/candles.ts";
import type { FetchCandles, Logger } from "../../src/engine/types.ts";
import { buildState } from "../engine/helpers.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import type { PaperState } from "../../src/engine/state.ts";
import type { FillMode } from "../../src/server/config.ts";

export function stubFetchCandles(byPair: Record<string, Candle[]>): FetchCandles {
  return async (pair, fromMs, toMs) => {
    const data = (byPair[pair] ?? []).filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
    return { success: true, data };
  };
}

// 既定は path: null（ファイルを書かない）。永続化を見るテストだけ実パスを渡す。
export type TestServerOptions = {
  path?: string | null;
  fillMode?: FillMode;
  controlEnabled?: boolean;
  /** 既定は捨てる。ログの副作用が応答に出ないことを見るテストだけが渡す。 */
  logger?: Logger;
};

export async function buildTestServer(
  state: PaperState = buildState(),
  candlesByPair: Record<string, Candle[]> = {},
  opts: TestServerOptions = {},
) {
  const store = new SessionStore(state, {
    path: opts.path ?? null,
    fillMode: opts.fillMode ?? "market",
    fetchCandles: stubFetchCandles(candlesByPair),
    logger: opts.logger,
  });
  const fastify = await buildServer({
    store,
    logger: false,
    controlEnabled: opts.controlEnabled ?? false,
  });
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
    opts: TestServerOptions = {},
  ) => {
    const r = await buildTestServer(state, candlesByPair, opts);
    cleanups.push(r.close);
    return r;
  };
}
