import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultStatePath, loadState, saveState } from "../../src/engine/persist.ts";
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
      amount: 0.002,
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ],
};

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
    const state = buildState({ orders: [buildOrder()], trades: [buildTrade()] });
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
