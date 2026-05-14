import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultStatePath, loadState, saveState } from "../../src/engine/persist.ts";
import {
  availableOf,
  computeLocked,
  DEFAULT_TAKER_FEE_RATE,
  genId,
  nowIso,
  PaperStateSchema,
} from "../../src/engine/state.ts";
import { buildOrder, buildState } from "./helpers.ts";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bitbank-mock-state-"));
  statePath = join(dir, "state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("schema", () => {
  it("validates a fresh v2 state", () => {
    const parsed = PaperStateSchema.safeParse(buildState());
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown version", () => {
    const parsed = PaperStateSchema.safeParse({ ...buildState(), version: 99 });
    expect(parsed.success).toBe(false);
  });
});

describe("pure helpers", () => {
  it("nowIso returns ISO8601 with ms+Z", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("genId is unique enough across rapid calls", () => {
    const ids = new Set(Array.from({ length: 200 }, () => genId()));
    expect(ids.size).toBe(200);
  });

  it("computeLocked: buy locks quote with fee, sell locks base", () => {
    const state = buildState({
      openOrders: [
        buildOrder({ id: "b", side: "buy", pair: "btc_jpy", price: 1000, amount: 2 }),
        buildOrder({ id: "s", side: "sell", pair: "btc_jpy", price: 1000, amount: 0.5 }),
      ],
    });
    const locked = computeLocked(state, 0.001);
    expect(locked.jpy).toBeCloseTo(1000 * 2 * 1.001, 6);
    expect(locked.btc).toBeCloseTo(0.5, 6);
  });

  it("availableOf subtracts locked from total", () => {
    const state = buildState({
      balances: { jpy: 1_000_000, btc: 1 },
      openOrders: [buildOrder({ id: "b", side: "buy", price: 100_000, amount: 1 })],
    });
    expect(availableOf(state, "jpy", 0)).toBe(900_000);
    expect(availableOf(state, "btc", 0)).toBe(1);
  });

  it("DEFAULT_TAKER_FEE_RATE matches bitbank docs", () => {
    expect(DEFAULT_TAKER_FEE_RATE).toBe(0.0012);
  });
});

describe("persist", () => {
  it("save → load round trip preserves state", async () => {
    const state = buildState({ initialJpy: 42, balances: { jpy: 42 } });
    expect((await saveState(statePath, state)).success).toBe(true);
    const r = await loadState(statePath);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(state);
  });

  it("load on missing file returns null", async () => {
    const r = await loadState(join(dir, "nope.json"));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(null);
  });

  it("migrates v1 → v2 on load", async () => {
    const v1 = {
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-06-01T00:00:00.000Z",
      initialJpy: 1_000_000,
      balances: { jpy: 1_000_000 },
      history: [],
    };
    writeFileSync(statePath, JSON.stringify(v1));
    const r = await loadState(statePath);
    expect(r.success).toBe(true);
    if (!r.success || !r.data) throw new Error("unreachable");
    expect(r.data.version).toBe(2);
    expect(r.data.lastTickAt).toBe(v1.updatedAt);
    expect(r.data.openOrders).toEqual([]);
  });

  it("rejects malformed json with descriptive error", async () => {
    writeFileSync(statePath, "{ not valid");
    const r = await loadState(statePath);
    expect(r.success).toBe(false);
  });

  it("defaultStatePath honors BITBANK_MOCK_STATE_PATH override", () => {
    const orig = process.env.BITBANK_MOCK_STATE_PATH;
    process.env.BITBANK_MOCK_STATE_PATH = "/tmp/forced/state.json";
    try {
      expect(defaultStatePath("any-id")).toBe("/tmp/forced/state.json");
    } finally {
      if (orig === undefined) delete process.env.BITBANK_MOCK_STATE_PATH;
      else process.env.BITBANK_MOCK_STATE_PATH = orig;
    }
  });

  it("defaultStatePath uses BITBANK_MOCK_HOME + session id", () => {
    const origPath = process.env.BITBANK_MOCK_STATE_PATH;
    const origHome = process.env.BITBANK_MOCK_HOME;
    delete process.env.BITBANK_MOCK_STATE_PATH;
    process.env.BITBANK_MOCK_HOME = "/tmp/mock-home";
    try {
      expect(defaultStatePath("sess-1")).toBe("/tmp/mock-home/sessions/sess-1/state.json");
    } finally {
      if (origPath !== undefined) process.env.BITBANK_MOCK_STATE_PATH = origPath;
      if (origHome === undefined) delete process.env.BITBANK_MOCK_HOME;
      else process.env.BITBANK_MOCK_HOME = origHome;
    }
  });
});
