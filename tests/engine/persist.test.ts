import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultStatePath, loadState, saveState } from "../../src/engine/persist.ts";
import type { Logger } from "../../src/engine/types.ts";
import { loadOrInitDefault } from "../../src/store/session.ts";
import { buildOrder, buildState, buildTrade } from "./helpers.ts";

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
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
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
