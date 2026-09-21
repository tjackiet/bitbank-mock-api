import { afterEach } from "vitest";
import type { Candle } from "../../src/engine/candles.ts";
import type { PaperState } from "../../src/engine/state.ts";
import type { FetchCandles, Logger } from "../../src/engine/types.ts";
import type { FillMode } from "../../src/server/config.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildState } from "../engine/helpers.ts";

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
  /**
   * 既定は `SessionStore` の既定料率（`DEFAULT_TAKER_FEE_RATE`）。
   *
   * **率が経路の端まで通っているかを見るテストだけが渡す。** 既定のままだと、率を
   * 渡し忘れた経路と渡した経路が同じ値になり区別できない（実際 `GET /v1/user/assets` は
   * 渡し忘れていた）。
   */
  feeRate?: number;
  /**
   * 既定は `candlesByPair` を返すスタブ（`stubFetchCandles`）。**足の取得が失敗する筋を
   * 見るテストだけが渡す。** 渡さない限り外向きの口には落ちない（`SessionStore` の既定は
   * 公開 API で、`tests/network-guard.ts` がそれを落とす）。
   */
  fetchCandles?: FetchCandles;
};

export async function buildTestServer(
  state: PaperState = buildState(),
  candlesByPair: Record<string, Candle[]> = {},
  opts: TestServerOptions = {},
) {
  const store = new SessionStore(state, {
    path: opts.path ?? null,
    fillMode: opts.fillMode ?? "market",
    fetchCandles: opts.fetchCandles ?? stubFetchCandles(candlesByPair),
    logger: opts.logger,
    feeRate: opts.feeRate,
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
