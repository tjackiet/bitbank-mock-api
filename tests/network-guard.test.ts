import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/engine/types.ts";
import { SessionStore } from "../src/store/session.ts";
import { buildOrder, buildState } from "./engine/helpers.ts";
import { fetch as blockingFetch, takeBlockedRequests } from "./network-guard.ts";

/**
 * 番人そのものを見る（`tests/network-guard.ts` と `tests/no-network.ts`）。
 *
 * 検査を足したときは、**その検査が効いていること**も見る必要がある。番人が黙って
 * 空振りしていると、外向きの要求が出ていないのではなく**見ていない**状態になり、
 * しかもそれは全部緑に見える。`tests/structure.test.ts` の「導出が空振りしていない」と同じ狙い。
 *
 * ここは自分で記録を作るので、各 it は `takeBlockedRequests()` で自分の分を片付ける。
 * 片付けないと `tests/no-network.ts` の `afterEach` がこのテスト自身を落とす
 * （＝片付け忘れも検出される）。
 */

/** ループバック以外へ向いていること。宛先の値そのものではなく、外向きかどうかを見る。 */
function isOutbound(url: string): boolean {
  const { hostname } = new URL(url);
  return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
}

/**
 * スタブを渡し忘れた `SessionStore` を製品の経路で tick させて、番人の記録と warn を返す。
 *
 * `tick()` が足を取りに出るのは**約定待ちの注文があるペアだけ**なので、注文を 1 件置き、
 * `lastTickAt` を過去にして取得範囲を作る。
 */
async function tickWithoutStub(): Promise<{ blocked: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const logger: Logger = { warn: (m) => warnings.push(m), info: () => {} };
  const store = new SessionStore(
    buildState({
      orders: [buildOrder()],
      lastTickAt: new Date(Date.now() - 60_000).toISOString(),
    }),
    { path: null, fillMode: "market", logger },
  );
  // tick 自体は throw しない。ここで落ちないことが、番人が記録を持つ理由である。
  await store.tick(Date.now());
  return { blocked: takeBlockedRequests(), warnings };
}

describe("外向きの fetch を止める番人", () => {
  it("呼ばれたら記録して投げる", () => {
    expect(() => blockingFetch("https://example.test/candlestick")).toThrow(
      /テストから外向きの fetch が呼ばれました/,
    );
    expect(takeBlockedRequests()).toEqual(["https://example.test/candlestick"]);
  });

  it("`URL` と `Request` 風の入力も宛先として記録する", () => {
    expect(() => blockingFetch(new URL("https://example.test/a"))).toThrow();
    expect(() => blockingFetch({ url: "https://example.test/b" })).toThrow();
    expect(takeBlockedRequests()).toEqual(["https://example.test/a", "https://example.test/b"]);
  });

  it("記録は取り出すと空になる", () => {
    expect(() => blockingFetch("https://example.test/c")).toThrow();
    expect(takeBlockedRequests()).toHaveLength(1);
    // 2 回目は空。ここが残ると、後続のテストが身に覚えのない記録で落ちる。
    expect(takeBlockedRequests()).toEqual([]);
  });

  it("`globalThis.fetch` も塞がっている", () => {
    // 本物の `fetch` は promise を reject するが、番人は**同期で投げる**。
    // `.catch()` しか置いていない経路でも握り潰されずに落ちるので、番人としてはこちらが強い。
    expect(() => fetch("https://example.test/global")).toThrow(
      /テストから外向きの fetch が呼ばれました/,
    );
    expect(takeBlockedRequests()).toEqual(["https://example.test/global"]);
  });

  /**
   * **これが本命。** スタブを渡し忘れた `SessionStore` が本物の口へ落ちることを、
   * 製品の経路（`tick()` → `defaultFetchCandles()` → `undici` の `fetch`）で見る。
   *
   * 併せて**なぜ記録が要るか**も固定する。`tick()` は取得の失敗を warn へ落として
   * 空の足で先へ進むので、番人が投げた例外はテストの結果に出てこない。投げるだけの
   * 番人だと、外へ出たテストはそのまま緑になる。
   */
  // 既定の宛先を見るために `vitest.config.ts` の歯止めを外す回があるので、毎回戻す。
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("スタブを渡さない SessionStore の tick が捕まる（失敗は握り潰される）", async () => {
    // `vitest.config.ts` は宛先側の歯止めとしてループバックを入れている。ここで見たいのは
    // **素の既定がどこへ向くか**なので、その値を外して `DEFAULT_BASE_URL` を出させる。
    // 外へ出ないのは番人が止めるからで、宛先の値に頼っていないことがこれで分かる。
    vi.stubEnv("BITBANK_PUBLIC_BASE_URL", undefined);

    const { blocked, warnings } = await tickWithoutStub();

    expect(blocked).toHaveLength(1);
    const url = blocked[0]!;
    expect(url).toContain("/btc_jpy/candlestick/");
    expect(isOutbound(url), `${url} が外向きでない`).toBe(true);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tick: fetchCandles failed");
  });

  /**
   * 2 枚目——宛先側の歯止め（`vitest.config.ts` の `env.BITBANK_PUBLIC_BASE_URL`）。
   *
   * 番人を外す変異を試したとき、テストから公開 API へ向かう要求がそのまま走った。
   * 番人が無くても**届かない**ようにしてあることを、ここで固定する。この値が消えると
   * 番人だけが頼りになるので落とす。
   */
  it("番人が外れても届かないよう、既定の宛先がループバックへ寄せてある", async () => {
    const { blocked } = await tickWithoutStub();

    expect(blocked).toHaveLength(1);
    const url = blocked[0]!;
    expect(isOutbound(url), `${url} が外へ向いている`).toBe(false);
  });
});
