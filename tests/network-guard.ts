/**
 * テストから外向きの要求が出るのを止める番人。**`undici` の代わりに読み込まれる。**
 *
 * `vitest.config.ts` の `test.alias` が `undici` をこのファイルへ向けているので、
 * `src/engine/candles.ts` の `import { fetch as undiciFetch } from "undici"` は
 * テスト中だけここの `fetch` を掴む。
 *
 * ## なぜ要るか
 *
 * `SessionStore` は `fetchCandles` を渡さないと**本物の口**に落ちる
 * （`src/store/session.ts` の `opts.fetchCandles ?? defaultFetchCandles()`）。
 * 行き先は `BITBANK_PUBLIC_BASE_URL` か、無ければ bitbank の公開 API である。
 *
 * 今のテストが外へ出ていないのは、`fetchCandles` を渡すか `fillMode: "manual"` に
 * するかを**書く人が覚えている**からで、機械は何も見ていなかった。しかも外れたときに
 * 黙る——`tick()` は取得の失敗を warn へ落として空の足で先へ進むので
 * （`src/store/session.ts` の `tick: fetchCandles failed`）、**実際に外へ要求を出した
 * テストがそのまま緑になる**。`getLatestPrice()` に至っては `fillMode` の早期 return の
 * 外にあり、manual でも成行の発注経路（`src/routes/create-order.ts`）から呼ばれる。
 *
 * ## 規則
 *
 * **テストからの `fetch` は宛先を問わず全部止める。** ループバックだけ通す案もあったが、
 * 通す側を検証するにはこの番人がローカルのサーバを要ることになる。今は `fetch` を使う
 * テストが 1 件も無いので、例外の無い規則にしてある。ローカルへ話す必要が出たら
 * `tests/scenarios/example-script.test.ts` のように子プロセスから叩くか、`node:http` を使う。
 *
 * 止めた要求は記録して `tests/no-network.ts` の `afterEach` が**テストを落とす**。
 * 投げるだけでは足りない——`fetchOneDay()` の `try`/`catch` が握り潰すので、
 * 投げた例外はテストの結果に出てこない。
 */

/** 止めた要求の記録。読み出しは `takeBlockedRequests()` から行う。 */
const blocked: string[] = [];

/**
 * 記録を取り出して空にする。番人自身を検証するテストは、これで自分の分を片付ける
 * （片付けないと `tests/no-network.ts` の `afterEach` がそのテストを落とす）。
 */
export function takeBlockedRequests(): string[] {
  return blocked.splice(0);
}

/**
 * `undici` の `fetch` の代わり。呼ばれたら記録して投げる。
 *
 * 実際の `fetch` は URL 以外に `Request` も受けるが、ここで要るのは**何処へ出ようとしたか**
 * だけなので、素直に文字列へ均す。
 *
 * 本物は promise を reject するが、ここは**同期で投げる**。`await fetchImpl(url)` の
 * `try` は同じように捕まえるうえ、`.catch()` しか置いていない経路では握り潰されずに
 * そのまま落ちるので、番人としてはこちらが強い。
 */
export function fetch(input: unknown): never {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : typeof input === "object" && input !== null && "url" in input
          ? String((input as { url: unknown }).url)
          : String(input);
  blocked.push(url);
  throw new Error(
    `テストから外向きの fetch が呼ばれました: ${url}\n` +
      "スタブ（`fetchCandles` / `fetchImpl`）を渡し忘れていないか確認してください。",
  );
}
