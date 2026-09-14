import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invariantViolations, preconditionViolations } from "../../src/engine/invariants.ts";
import { defaultStatePath, loadState, saveState } from "../../src/engine/persist.ts";
import { fillOrder, placeOrder } from "../../src/engine/transitions.ts";
import type { Logger } from "../../src/engine/types.ts";
import { loadOrInitDefault } from "../../src/store/session.ts";
import { buildOrder, buildState, buildTrade } from "./helpers.ts";

// `rename` の後のディレクトリの fsync を観測する入れ物。既定は素通しで、
// 失敗させるテストだけが dirFsync.fail を立てる。
const dirFsync = vi.hoisted(() => ({ synced: [] as string[], fail: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    /**
     * `open` を包み、ディレクトリの handle の `sync()` だけを観測・失敗させる。
     *
     * 包むのは `"r"` で開いたときだけである。`saveState` はディレクトリを `"r"`、
     * 一時ファイルを `"wx"` で開き、状態の読み込みは `readFile` を通るので混ざらない。
     *
     * **観測も注入も `sync()` の側で行う。** `open` の時点で拾うと、fsync を呼ばずに
     * `open` と `close` だけする退行をテストが素通しする（実際に `syncDirectory()` から
     * `dh.sync()` を外して 40 件すべて通ることを確認した）。固定したいのは
     * 「ディレクトリを開いたこと」ではなく「fsync したこと」である。
     */
    open: async (p: Parameters<typeof actual.open>[0], flags?: unknown, mode?: unknown) => {
      const fh = await actual.open(p, flags as never, mode as never);
      if (flags !== "r") return fh;
      return new Proxy(fh, {
        get(target, prop) {
          if (prop === "sync") {
            return async () => {
              dirFsync.synced.push(String(p));
              if (dirFsync.fail) {
                throw Object.assign(new Error("EINVAL: invalid argument, fsync"), { code: "EINVAL" });
              }
              return target.sync();
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const V1_STATE = {
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  initialJpy: 1_000_000,
  balances: { jpy: 994_000, btc: 0.001 },
  history: [
    {
      id: "7",
      pair: "btc_jpy",
      side: "buy",
      type: "market",
      amount: 0.001,
      fillPrice: 5_000_000,
      feeJpy: 6,
      filledAt: "2026-01-01T12:00:00.000Z",
    },
  ],
};

// 売り注文の量は btc 残高（0.001）以下でなければならない。v2 のエンジンも発注時に
// availableOf で拘束を見ていたので、これを超える openOrders は v2 では作れない。
// 超えていると移行後に不変量 6（locked <= 残高）を破り、書き戻した v3 が読めなくなる。
const V2_STATE = {
  ...V1_STATE,
  version: 2,
  lastTickAt: "2026-01-02T00:00:00.000Z",
  openOrders: [
    {
      id: "9",
      pair: "btc_jpy",
      side: "sell",
      type: "limit",
      price: 6_000_000,
      amount: 0.001,
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ],
};

// スキーマは通るが不変量を破る v3 の状態。注文 1 件で executedAmount > startAmount、
// status は UNFILLED、trades は空、jpy 残高は負。不変量 1 / 2 / 5 / 5 / 6 / 6 を破る。
const INVARIANT_BREAKING = buildState({
  balances: { jpy: -500_000 },
  orders: [buildOrder({ executedAmount: 0.005, executedNotional: 25_000 })],
  trades: [],
});

// 移行の結果が不変量を破る v2。売り 0.002 btc に対し btc 残高は 0.001 しかない。
// v2 のエンジンはこの発注を INSUFFICIENT_FUNDS で断ったので、v2 が書いた state には
// 現れないが、手で書かれた state や別実装が書いた state では起こり得る。
const V2_OVERSOLD = {
  ...V2_STATE,
  openOrders: [
    {
      id: "9",
      pair: "btc_jpy",
      side: "sell",
      type: "limit",
      price: 6_000_000,
      amount: 0.002,
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ],
};

/** warn を配列へ溜めるロガー。移行時の警告を検査するために使う。 */
function collectingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return { logger: { warn: (m) => warnings.push(m), info: () => {} }, warnings };
}

describe("loadState", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-load-"));
    path = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ファイルが無ければ null を返す（新規セッション）", async () => {
    const r = await loadState(path);
    expect(r).toEqual({ success: true, data: null });
  });

  // 壊れた state を黙って初期化すると、受理済みの注文が消えたまま起動してしまう。
  // 読めない state は必ず失敗として返し、loadOrInitDefault は throw する。
  const broken: Array<[string, string]> = [
    ["不正な JSON", "{ orders: [] "],
    ["空ファイル", ""],
    ["スキーマ違反（未知の version）", JSON.stringify({ version: 99, orders: [] })],
    ["スキーマ違反（必須フィールド欠落）", JSON.stringify({ version: 3, orders: [] })],
    [
      "途中で切れたファイル",
      `${JSON.stringify(buildState({ orders: [buildOrder()] }), null, 2)}\n`.slice(0, 120),
    ],
  ];

  for (const [name, content] of broken) {
    it(`${name} では fail-closed になり、初期状態へ戻さない`, async () => {
      await writeFile(path, content, "utf-8");
      const r = await loadState(path);
      expect(r.success).toBe(false);

      await expect(loadOrInitDefault(1_000_000, { path })).rejects.toThrow();
      // 起動に失敗しても壊れたファイルはそのまま残す（調査できるように）。
      expect(await readFile(path, "utf-8")).toBe(content);
    });
  }
});

describe("読み込み時の不変量検査", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-invariants-"));
    path = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // スキーマだけでは負の remaining_amount を持つ状態が通ってしまう。壊れた JSON と
  // 同じ fail-closed に揃え、不変量を破る状態では起動させない。
  it("不変量を破る v3 の state では fail-closed になる", async () => {
    const content = `${JSON.stringify(INVARIANT_BREAKING, null, 2)}\n`;
    await writeFile(path, content, "utf-8");

    const r = await loadState(path);
    expect(r.success).toBe(false);
    if (r.success) throw new Error("unreachable");
    expect(r.error).toContain("paper state violates invariants");
    // どの不変量のどの注文かが分かること（invariantViolations の文字列をそのまま出す）。
    expect(r.error).toContain("6 violation(s)");
    expect(r.error).toContain("1: order 1 executedAmount=0.005 startAmount=0.001");
    expect(r.error).toContain("2: order 1 status=UNFILLED executedAmount=0.005");
    expect(r.error).toContain("5: order 1 trades=0 executedAmount=0.005");
    expect(r.error).toContain("5: order 1 tradeNotional=0 executedNotional=25000");
    expect(r.error).toContain("6: balance[jpy]=-500000 is negative");
    expect(r.error).toContain("6: locked[jpy]=");

    // 起動も失敗し、違反の内容はそのまま throw されるメッセージに乗る。
    await expect(loadOrInitDefault(1_000_000, { path })).rejects.toThrow(
      /1: order 1 executedAmount=0.005 startAmount=0.001/,
    );
    // 壊れたファイルは直さず、消さずに残す。
    expect(await readFile(path, "utf-8")).toBe(content);
  });

  // 不変量 6 の検査は資産キーで残高と拘束を引く。`constructor` という資産名では
  // Object.prototype の継承値を掴んで比較が NaN になり、この state が素通りしていた。
  it("資産名が Object.prototype のキーでも fail-closed になる", async () => {
    const state = buildState({
      balances: { jpy: 1_000_000 },
      orders: [
        buildOrder({ id: "1", side: "sell", pair: "constructor_jpy", price: 100, startAmount: 999 }),
      ],
    });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    const r = await loadState(path);
    expect(r.success).toBe(false);
    if (r.success) throw new Error("unreachable");
    expect(r.error).toContain("6: locked[constructor]=999 exceeds balance=0");
    await expect(loadOrInitDefault(1_000_000, { path })).rejects.toThrow(/locked\[constructor\]/);
  });

  it("不変量を満たす v3 の state では起動する", async () => {
    const state = buildState({
      balances: { jpy: 9_995_000, btc: 0.001 },
      orders: [
        buildOrder({ status: "FULLY_FILLED", executedAmount: 0.001, executedNotional: 5_000 }),
        buildOrder({ id: "2", side: "sell", price: 6_000_000, startAmount: 0.001 }),
      ],
      trades: [buildTrade()],
      nextOrderSeq: 3,
      nextTradeSeq: 2,
    });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    expect(await loadState(path)).toEqual({ success: true, data: state });
    const store = await loadOrInitDefault(1_000_000, { path, fillMode: "manual" });
    expect(store.state()).toEqual(state);
  });

  // 不変量 6 の拘束額は手数料込みなので、SessionStore と同じ手数料率で判定しないと
  // 境界の注文で結果が変わる。loadOrInitDefault は opts.feeRate をそのまま渡す。
  it("不変量 6 の判定には呼び出し側の手数料率を使う", async () => {
    const price = 5_000_000;
    const amount = 0.002;
    const state = buildState({
      balances: { jpy: price * amount },
      orders: [buildOrder({ price, startAmount: amount })],
    });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    // 既定の手数料率では手数料の分だけ拘束が残高を超える。
    const withFee = await loadState(path);
    expect(withFee.success).toBe(false);
    if (withFee.success) throw new Error("unreachable");
    expect(withFee.error).toContain("6: locked[jpy]=");
    await expect(loadOrInitDefault(1_000_000, { path })).rejects.toThrow();

    // 手数料 0 の store では拘束はちょうど残高に等しく、違反ではない。
    expect(await loadState(path, { feeRate: 0 })).toEqual({ success: true, data: state });
    const store = await loadOrInitDefault(1_000_000, { path, feeRate: 0, fillMode: "manual" });
    expect(store.state()).toEqual(state);
  });

  // 移行の入力は本モックが書いたとは限らない。ここで落とすと旧 state の利用者が
  // 起動できなくなるので、移行の結果が破っている場合は warn だけ出して起動する。
  it("移行の結果が不変量を破るときは warn を出して起動する", async () => {
    await writeFile(path, `${JSON.stringify(V2_OVERSOLD, null, 2)}\n`, "utf-8");

    const { logger, warnings } = collectingLogger();
    const r = await loadState(path, { logger });
    expect(r.success).toBe(true);
    if (!r.success || !r.data) throw new Error("unreachable");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("migrated paper state violates invariants");
    expect(warnings[0]).toContain("6: locked[btc]=0.002 exceeds balance=0.001");

    // ただし移行後の v3 を書き戻すと、次の起動は v3 として fail-closed になる。
    expect(await saveState(path, r.data)).toEqual({ success: true, data: true });
    const second = await loadState(path, { logger });
    expect(second.success).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it("不変量を満たす v2 の移行では warn を出さない", async () => {
    await writeFile(path, `${JSON.stringify(V2_STATE, null, 2)}\n`, "utf-8");
    const { logger, warnings } = collectingLogger();
    const r = await loadState(path, { logger });
    expect(r.success).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe("読み込み時の前提の検査", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-precond-"));
    path = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // 同じ id が 2 件あると replaceOrder が id 一致の全件を置き換えるので、active な方への
  // 約定が終端レコードまで書き換える（不変量 4 が破れる）。runTick は同じ id を 2 回
  // applyFill へ渡して 500 になる。読み込みで落として、起動させない。
  it("注文 id が重複する v3 の state では fail-closed になる", async () => {
    const content = `${JSON.stringify(
      buildState({ orders: [buildOrder(), buildOrder({ status: "REJECTED" })] }),
      null,
      2,
    )}\n`;
    await writeFile(path, content, "utf-8");

    const r = await loadState(path);
    expect(r.success).toBe(false);
    if (r.success) throw new Error("unreachable");
    expect(r.error).toContain("paper state violates invariant preconditions");
    // どの id が重なっているかがメッセージに出ること。
    expect(r.error).toContain("order-id: duplicate order id 1 (2 records)");

    await expect(loadOrInitDefault(1_000_000, { path })).rejects.toThrow(
      /order-id: duplicate order id 1 \(2 records\)/,
    );
    // 壊れたファイルは直さず、消さずに残す。
    expect(await readFile(path, "utf-8")).toBe(content);
  });

  // trade id の重複は trade_history に同じ trade_id の 2 行として出る。
  it("trade id が重複する v3 の state では fail-closed になる", async () => {
    const state = buildState({
      orders: [
        buildOrder({ status: "FULLY_FILLED", executedAmount: 0.002, executedNotional: 10_000 }),
      ],
      trades: [buildTrade(), buildTrade()],
    });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    const r = await loadState(path);
    expect(r.success).toBe(false);
    if (r.success) throw new Error("unreachable");
    expect(r.error).toContain("trade-id: duplicate trade id 1 (2 records)");
    await expect(loadOrInitDefault(1_000_000, { path })).rejects.toThrow(
      /trade-id: duplicate trade id 1/,
    );
  });

  // この state 自身に重複は無いが、採番が id 5 に追いつく発注で重複が生まれる。
  // 重複してから落とすのでは遅いので、採番と既存 id の食い違いを読み込みで落とす。
  it("nextOrderSeq が既存の注文 id 以下の state では fail-closed になる", async () => {
    const state = buildState({
      balances: { jpy: 10_000_000, btc: 1 },
      orders: [buildOrder({ id: "5", side: "sell" })],
      nextOrderSeq: 3,
    });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    const r = await loadState(path);
    expect(r.success).toBe(false);
    if (r.success) throw new Error("unreachable");
    // どのフィールドがどの id と食い違っているかが出ること。
    expect(r.error).toContain("order-seq: nextOrderSeq=3 <= existing order id 5");
    await expect(loadOrInitDefault(1_000_000, { path })).rejects.toThrow(
      /order-seq: nextOrderSeq=3 <= existing order id 5/,
    );
  });

  it("nextTradeSeq が既存の trade id 以下の state でも fail-closed になる", async () => {
    const state = buildState({
      orders: [
        buildOrder({ status: "FULLY_FILLED", executedAmount: 0.001, executedNotional: 5_000 }),
      ],
      trades: [buildTrade({ tradeId: "2" })],
      nextTradeSeq: 2,
    });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    const r = await loadState(path);
    expect(r.success).toBe(false);
    if (r.success) throw new Error("unreachable");
    expect(r.error).toContain("trade-seq: nextTradeSeq=2 <= existing trade id 2");
  });

  // 採番の飽和は配る側（transitions.ts の canIssue）が止めるので、読み込みでは落とさない。
  // ここで落とすと、遷移関数だけを通って作った状態が次の起動で読めなくなる。
  // `nextOrderSeq = Number.MAX_SAFE_INTEGER` の state は id 9007199254740991 を 1 件配れて、
  // そのとき書き出される採番は 9007199254740992 になるため。
  it("採番を使い切った直後の状態を書き出して読み戻せる", async () => {
    const seed = buildState({
      balances: { jpy: 1_000_000_000_000, btc: 1_000_000 },
      nextOrderSeq: Number.MAX_SAFE_INTEGER,
    });
    const placed = placeOrder(
      seed,
      { pair: "btc_jpy", side: "sell", type: "limit", amount: 0.001, price: 6_000_000 },
      "2026-01-01T00:00:00.000Z",
      undefined,
      0,
    );
    if (!placed.success) throw new Error(placed.error);
    expect(placed.data.order.id).toBe("9007199254740991");
    expect(placed.data.state.nextOrderSeq).toBe(Number.MAX_SAFE_INTEGER + 1);

    expect(await saveState(path, placed.data.state)).toEqual({ success: true, data: true });
    expect(await loadState(path, { feeRate: 0 })).toEqual({
      success: true,
      data: placed.data.state,
    });
    // 起動もでき、以後の発注だけが断られる（重複 id は配らない）。
    const store = await loadOrInitDefault(1_000_000, { path, feeRate: 0, fillMode: "manual" });
    expect(store.state().nextOrderSeq).toBe(Number.MAX_SAFE_INTEGER + 1);
  });

  it("trade の採番を使い切った直後の状態も読み戻せる", async () => {
    const seed = buildState({
      balances: { jpy: 1_000_000_000_000, btc: 1_000_000 },
      orders: [buildOrder({ side: "sell" })],
      nextTradeSeq: Number.MAX_SAFE_INTEGER,
    });
    const filled = fillOrder(seed, "1", 5_000_000, 0.001, "2026-01-01T00:01:00.000Z", 0);
    if (!filled.success) throw new Error(filled.error);
    expect(filled.data.trade?.tradeId).toBe("9007199254740991");
    expect(filled.data.state.nextTradeSeq).toBe(Number.MAX_SAFE_INTEGER + 1);

    expect(await saveState(path, filled.data.state)).toEqual({ success: true, data: true });
    expect(await loadState(path, { feeRate: 0 })).toEqual({
      success: true,
      data: filled.data.state,
    });
  });

  // 残量 0 のまま永遠に active で、fillOrder が非正の量を断るので約定させる手段が無い。
  it("startAmount == 0 の UNFILLED 注文を含む state では fail-closed になる", async () => {
    const state = buildState({ orders: [buildOrder({ startAmount: 0 })] });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    const r = await loadState(path);
    expect(r.success).toBe(false);
    if (r.success) throw new Error("unreachable");
    expect(r.error).toContain("start-amount: order 1 startAmount=0");
    await expect(loadOrInitDefault(1_000_000, { path })).rejects.toThrow(
      /start-amount: order 1 startAmount=0/,
    );
  });

  // 前提を落とすときは不変量の違反を並べない（id が重複していると `5: order 1 ...` が
  // どちらのレコードの話か定まらないため）。
  it("前提が破れているときは不変量の違反を並べない", async () => {
    const state = buildState({
      balances: { jpy: -1 },
      orders: [buildOrder(), buildOrder({ status: "REJECTED" })],
    });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    const r = await loadState(path);
    expect(r.success).toBe(false);
    if (r.success) throw new Error("unreachable");
    expect(r.error).toContain("order-id: duplicate order id 1");
    expect(r.error).not.toContain("6: balance[jpy]");
  });

  it("前提を満たす v3 の state では引き続き起動する", async () => {
    const state = buildState({
      balances: { jpy: 9_995_000, btc: 0.001 },
      orders: [
        buildOrder({ status: "FULLY_FILLED", executedAmount: 0.001, executedNotional: 5_000 }),
        buildOrder({ id: "2", side: "sell", price: 6_000_000 }),
      ],
      trades: [buildTrade()],
    });
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

    expect(await loadState(path)).toEqual({ success: true, data: state });
    const store = await loadOrInitDefault(1_000_000, { path, fillMode: "manual" });
    expect(store.state()).toEqual(state);
  });
});

describe("状態の移行", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-migrate-"));
    path = join(dir, "state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // 移行は冪等でなければならない。v1 / v2 を読んで v3 として書き戻し、
  // もう一度読んだときに結果が変わると、再起動のたびに状態が動いてしまう。
  for (const [name, legacy] of [["v1", V1_STATE], ["v2", V2_STATE]] as const) {
    it(`${name} → v3 の移行は冪等`, async () => {
      await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");

      const first = await loadState(path);
      if (!first.success || !first.data) throw new Error("移行に失敗した");
      expect(first.data.version).toBe(3);

      // 同じファイルをもう一度読んでも同じ結果（読み取り自体が決定的）。
      const again = await loadState(path);
      if (!again.success) throw new Error(again.error);
      expect(again.data).toEqual(first.data);

      // v3 として書き戻して読み直しても同じ（書き戻しが移行を二重適用しない）。
      expect(await saveState(path, first.data)).toEqual({ success: true, data: true });
      const second = await loadState(path);
      if (!second.success) throw new Error(second.error);
      expect(second.data).toEqual(first.data);
    });
  }

  // 移行は openOrders → history の順に積むだけで、かつては id の衝突を見ていなかった。
  // 重複を抱えたまま起動すると replaceOrder が id 一致の全件を置き換えて 500 や
  // 「取消も約定もできない注文」に化けるので、移行の側で衝突しない id を振り直す。
  // これは壊れた v3 の自動修復とは別で、積み直しを決める移行そのものの一部である。
  it("移行は重複した注文 id を振り直す（openOrders 同士も history との衝突も）", async () => {
    const dup = {
      ...V2_STATE,
      balances: { jpy: 994_000, btc: 0.01 },
      openOrders: [
        { ...V2_STATE.openOrders[0], id: "9", price: 6_000_000 },
        { ...V2_STATE.openOrders[0], id: "9", price: 7_000_000 },
      ],
      history: [{ ...V1_STATE.history[0], id: "9" }],
    };
    await writeFile(path, `${JSON.stringify(dup, null, 2)}\n`, "utf-8");

    const { logger, warnings } = collectingLogger();
    const r = await loadState(path, { logger });
    if (!r.success || !r.data) throw new Error("移行に失敗した");

    // 先に積まれる openOrders が id を保つ（生きている注文の id は取消に使うため）。
    expect(r.data.orders.map((o) => [o.id, o.status, o.price])).toEqual([
      ["9", "UNFILLED", 6_000_000],
      ["1", "UNFILLED", 7_000_000],
      ["2", "FULLY_FILLED", null],
    ]);
    // trade は振り直した後の注文を指す（不変量 5 の孤児 trade にしない）。
    expect(r.data.trades.map((t) => [t.tradeId, t.orderId])).toEqual([["1", "2"]]);
    // 採番は振り直した後の全 id より大きい。
    expect(r.data.nextOrderSeq).toBe(10);
    expect(r.data.nextTradeSeq).toBe(2);

    // 重複が残っていないので warn は出ず、そのまま起動できる。
    expect(warnings).toEqual([]);
    expect(preconditionViolations(r.data)).toEqual([]);
    expect(invariantViolations(r.data)).toEqual([]);
    const store = await loadOrInitDefault(1_000_000, { path, fillMode: "manual" });
    expect(store.state()).toEqual(r.data);

    // 書き戻した v3 も読める（移行の出力が自分の検査に落ちない）。
    expect(await saveState(path, r.data)).toEqual({ success: true, data: true });
    const second = await loadState(path, { logger });
    expect(second.success).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("v1 の history 内の重複も振り直す", async () => {
    const dup = {
      ...V1_STATE,
      history: [V1_STATE.history[0], { ...V1_STATE.history[0], id: "7" }],
      balances: { jpy: 988_000, btc: 0.002 },
    };
    await writeFile(path, `${JSON.stringify(dup, null, 2)}\n`, "utf-8");

    const r = await loadState(path);
    if (!r.success || !r.data) throw new Error("移行に失敗した");
    expect(r.data.orders.map((o) => o.id)).toEqual(["7", "1"]);
    expect(r.data.trades.map((t) => [t.tradeId, t.orderId])).toEqual([["1", "7"], ["2", "1"]]);
    expect(preconditionViolations(r.data)).toEqual([]);
  });

  // 振り直しは重複した id にだけ効く。衝突していない id は移行の前後で変わらない。
  it("重複していない id は移行で変えない", async () => {
    await writeFile(path, `${JSON.stringify(V2_STATE, null, 2)}\n`, "utf-8");
    const r = await loadState(path);
    if (!r.success || !r.data) throw new Error("移行に失敗した");
    expect(r.data.orders.map((o) => o.id)).toEqual(["9", "7"]);
  });

  // id の重複以外の前提の破れは移行では直せない（数量を書き換えるのは変換ではなく修復）。
  // 不変量と同じく warn で起動し、v3 として書き戻された後は fail-closed にかかる。
  it("移行の結果が前提を破るときは warn を出して起動する", async () => {
    const zeroAmount = {
      ...V2_STATE,
      openOrders: [{ ...V2_STATE.openOrders[0], amount: 0 }],
    };
    await writeFile(path, `${JSON.stringify(zeroAmount, null, 2)}\n`, "utf-8");

    const { logger, warnings } = collectingLogger();
    const r = await loadState(path, { logger });
    expect(r.success).toBe(true);
    if (!r.success || !r.data) throw new Error("unreachable");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("migrated paper state violates invariant preconditions");
    expect(warnings[0]).toContain("start-amount: order 9 startAmount=0");

    expect(await saveState(path, r.data)).toEqual({ success: true, data: true });
    const second = await loadState(path, { logger });
    expect(second.success).toBe(false);
    if (second.success) throw new Error("unreachable");
    expect(second.error).toContain("start-amount: order 9 startAmount=0");
  });

  it("v2 の openOrders と history が v3 の orders / trades になる", async () => {
    await writeFile(path, `${JSON.stringify(V2_STATE, null, 2)}\n`, "utf-8");
    const r = await loadState(path);
    if (!r.success || !r.data) throw new Error("移行に失敗した");
    expect(r.data.orders.map((o) => [o.id, o.status])).toEqual([
      ["9", "UNFILLED"],
      ["7", "FULLY_FILLED"],
    ]);
    expect(r.data.trades).toHaveLength(1);
    expect(r.data.nextOrderSeq).toBe(10);
    expect(r.data.nextTradeSeq).toBe(2);
  });
});

describe("saveState", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-save-"));
    path = join(dir, "nested", "state.json");
    // 他の describe も saveState を呼ぶので、観測は各テストの開始時に空にする。
    dirFsync.synced = [];
    dirFsync.fail = false;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    dirFsync.synced = [];
    dirFsync.fail = false;
  });

  // rename はディレクトリの更新なので、親を fsync しないと OS ごと落ちたときに
  // 差し替えが失われる（ファイルの中身は fh.sync() で落ちている）。
  it("rename の後に状態ファイルの親ディレクトリを fsync する", async () => {
    expect(await saveState(path, buildState())).toEqual({ success: true, data: true });
    expect(dirFsync.synced).toEqual([join(dir, "nested")]);
  });

  // ディレクトリの fsync はどの環境でも通るとは限らない。ここで失敗を書き込みの失敗へ
  // 昇格させると、今まで書けていた環境が書けなくなる。警告だけ出して成功のまま返す。
  it("ディレクトリの fsync が失敗しても書き込みは成功し、警告だけ出す", async () => {
    const state = buildState();
    const warnings: string[] = [];
    dirFsync.fail = true;

    const r = await saveState(path, state, { logger: { warn: (m) => warnings.push(m), info: () => {} } });

    expect(r).toEqual({ success: true, data: true });
    // 状態ファイルは置かれていて、そのまま読み戻せる。
    expect(await loadState(path)).toEqual({ success: true, data: state });
    expect(await readdir(join(dir, "nested"))).toEqual(["state.json"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(JSON.stringify(join(dir, "nested")));
    expect(warnings[0]).toContain("EINVAL");
    // 失敗したのは fsync であって open ではない（handle は開けている）。
    expect(dirFsync.synced).toEqual([join(dir, "nested")]);
  });

  // この戻り値は呼び出し側が状態の扱いを決める根拠になるので、ログの副作用で
  // 反転してはいけない（成立した書き込みを失敗として報告させない）。
  it("warn が投げても書き込みは成功のまま返す", async () => {
    dirFsync.fail = true;
    const r = await saveState(path, buildState(), {
      logger: { warn: () => { throw new Error("logger が壊れている"); }, info: () => {} },
    });
    expect(r).toEqual({ success: true, data: true });
    expect(existsSync(path)).toBe(true);
  });

  it("logger を渡さなければディレクトリの fsync が失敗しても黙って成功する", async () => {
    dirFsync.fail = true;
    expect(await saveState(path, buildState())).toEqual({ success: true, data: true });
    expect(existsSync(path)).toBe(true);
  });

  it("書き出した状態をそのまま読み戻せて、一時ファイルを残さない", async () => {
    // 注文と trade は揃える（trade の合計 == executedAmount。不変量 5）。
    // 読み込みが不変量を検査するので、食い違った状態は読み戻せない。
    const state = buildState({
      orders: [buildOrder({ status: "FULLY_FILLED", executedAmount: 0.001, executedNotional: 5_000 })],
      trades: [buildTrade()],
    });
    expect(await saveState(path, state)).toEqual({ success: true, data: true });
    const r = await loadState(path);
    expect(r).toEqual({ success: true, data: state });
    expect(await readdir(join(dir, "nested"))).toEqual(["state.json"]);
  });

  // open(tmp, "wx") は既存ファイルを開かない。Math.random を固定して
  // 一時ファイル名を先に作り、上書きも削除もされないことを見る。
  it("一時ファイル名が既に埋まっていれば、上書きも削除もせず失敗する", async () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const suffix = (0.5).toString(36).slice(2, 10);
      const tmp = `${path}.${process.pid}.${suffix}.tmp`;
      await saveState(path, buildState());
      await rm(path);
      await writeFile(tmp, "先客", "utf-8");

      const r = await saveState(path, buildState());
      expect(r.success).toBe(false);
      expect(await readFile(tmp, "utf-8")).toBe("先客");
      expect(existsSync(path)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("defaultStatePath", () => {
  it("BITBANK_MOCK_STATE_PATH を最優先で使う", () => {
    const env = { BITBANK_MOCK_STATE_PATH: "/tmp/x/state.json", BITBANK_MOCK_HOME: "/tmp/y" };
    expect(defaultStatePath("default", env)).toBe("/tmp/x/state.json");
  });

  it("BITBANK_MOCK_HOME 配下のセッションディレクトリへ解決する", () => {
    expect(defaultStatePath("s1", { BITBANK_MOCK_HOME: "/tmp/y" })).toBe(
      "/tmp/y/sessions/s1/state.json",
    );
  });

  // 空文字の env は「未設定」。`BITBANK_MOCK_HOME` をここで値として受けると
  // join("", ...) が相対パスになり、起動した作業ディレクトリごとに別の状態ファイルを掴む。
  it("空文字の BITBANK_MOCK_HOME は未設定として既定のホームへ落ちる", () => {
    const path = defaultStatePath("default", { BITBANK_MOCK_HOME: "" });
    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(join(homedir(), ".bitbank-mock", "sessions", "default", "state.json"));
  });

  it("空文字の BITBANK_MOCK_STATE_PATH は未設定として BITBANK_MOCK_HOME へ落ちる", () => {
    expect(defaultStatePath("s1", { BITBANK_MOCK_STATE_PATH: "", BITBANK_MOCK_HOME: "/tmp/y" })).toBe(
      "/tmp/y/sessions/s1/state.json",
    );
  });

  // 相対パスはどちらの env でも通す（明示的に渡した値を黙って書き換えない）。
  // docs/fidelity.md の「状態ファイルのパス解決」行がこの形を正とする。
  it("相対パスは STATE_PATH でも HOME でもそのまま相対パスとして解決する", () => {
    expect(defaultStatePath("s1", { BITBANK_MOCK_STATE_PATH: "rel.json" })).toBe("rel.json");
    expect(defaultStatePath("s1", { BITBANK_MOCK_HOME: "rel" })).toBe("rel/sessions/s1/state.json");
  });

  it("env 未指定なら process.env を読む", () => {
    const before = process.env.BITBANK_MOCK_STATE_PATH;
    process.env.BITBANK_MOCK_STATE_PATH = "/tmp/z/state.json";
    try {
      expect(defaultStatePath("default")).toBe("/tmp/z/state.json");
    } finally {
      if (before === undefined) delete process.env.BITBANK_MOCK_STATE_PATH;
      else process.env.BITBANK_MOCK_STATE_PATH = before;
    }
  });
});
