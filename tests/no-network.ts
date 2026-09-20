import { afterAll, afterEach, vi } from "vitest";
import { fetch as blockingFetch, takeBlockedRequests } from "./network-guard.ts";

/**
 * 外向きの要求を出したテストを落とす。`vitest.config.ts` の `setupFiles` から全ファイルに効く。
 *
 * 番人の本体と、なぜ要るかは `tests/network-guard.ts` にある。ここが持つのは
 * **落とし方**だけである。
 *
 * `undici` 側は `test.alias` が差し替えるので、ここでは残りの口——`globalThis.fetch`——を塞ぐ。
 * `src/` は今のところ `undici` しか使っていないが、口が増えたときに黙って外へ出ないようにする。
 * `vi.stubGlobal()` を使うのは、差し替えを vitest の管理下に置いて後始末を任せるため。
 */
vi.stubGlobal("fetch", blockingFetch);

/**
 * **投げるだけでは落ちない。** `src/engine/candles.ts` の `fetchOneDay()` は `fetch` の例外を
 * `catch` して `Result` の失敗へ変え、`SessionStore.tick()` はそれを warn へ落として先へ進む。
 * つまり外へ出たテストは、握り潰された経路をそのまま通って緑になる。記録を各テストの後で
 * 見て、ここで落とす。
 */
afterEach(() => {
  const blocked = takeBlockedRequests();
  if (blocked.length === 0) return;
  throw new Error(
    `このテストから外向きの要求が ${blocked.length} 件出ました:\n` +
      blocked.map((u) => `  - ${u}`).join("\n"),
  );
});

/** `beforeAll` など、どのテストにも属さない場所から出た分を取りこぼさない。 */
afterAll(() => {
  const blocked = takeBlockedRequests();
  if (blocked.length === 0) return;
  throw new Error(
    `テストの外（beforeAll / afterAll など）から外向きの要求が ${blocked.length} 件出ました:\n` +
      blocked.map((u) => `  - ${u}`).join("\n"),
  );
});
