import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadState } from "../../src/engine/persist.ts";
import { activeOrders, type PaperState } from "../../src/engine/state.ts";
import { loadOrInitDefault, SessionStore } from "../../src/store/session.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { buildTestServer, stubFetchCandles } from "../routes/helpers.ts";

// 重なった persist() が実際に 1 本にまとめられたかを見るため、saveState の
// 呼び出し回数を数える。中身は実物をそのまま呼ぶ。
const saveStateCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/engine/persist.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/persist.ts")>();
  return {
    ...actual,
    saveState: (...args: Parameters<typeof actual.saveState>) => {
      saveStateCalls.count += 1;
      return actual.saveState(...args);
    },
  };
});

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;

describe("SessionStore.tick", () => {
  it("fills active orders on every pair in one tick", async () => {
    const state = buildState({
      balances: { jpy: 10_000_000 },
      orders: [
        buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 }),
        buildOrder({ id: "2", pair: "eth_jpy", side: "buy", price: 100, startAmount: 1 }),
      ],
    });
    const store = new SessionStore(state, {
      path: null,
      fillMode: "market",
      fetchCandles: stubFetchCandles({
        btc_jpy: [candle(T0 + MIN, 110, 110, 50, 105)],
        eth_jpy: [candle(T0 + MIN, 110, 110, 50, 105)],
      }),
      feeRate: 0,
    });
    await store.tick(T0 + 2 * MIN);
    expect(activeOrders(store.state())).toHaveLength(0);
    expect(store.state().trades).toHaveLength(2);
  });

  it("does not fetch or fill in manual fillMode", async () => {
    let fetched = 0;
    const store = new SessionStore(
      buildState({
        balances: { jpy: 10_000_000 },
        orders: [buildOrder({ id: "1", side: "buy", price: 100, startAmount: 1 })],
      }),
      {
        path: null,
        fillMode: "manual",
        fetchCandles: async () => {
          fetched += 1;
          return { success: true, data: [candle(T0 + MIN, 110, 110, 50, 105)] };
        },
      },
    );
    await store.tick(T0 + 2 * MIN);
    expect(fetched).toBe(0);
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  // 状態ファイルのスキーマ（PaperStateSchema）は pair の文字種を見ないので、
  // 発注の検証より前に書かれた不正なペアの注文がそのまま読み込まれる。
  // そういう注文の分は外向きに問い合わせず、正常なペアの注文は今までどおり約定させる。
  it("skips malformed pairs loaded from a state file and still ticks valid ones", async () => {
    const fetched: string[] = [];
    const warnings: string[] = [];
    const store = new SessionStore(
      buildState({
        balances: { jpy: 10_000_000, btc: 1 },
        orders: [
          buildOrder({ id: "1", pair: "../../admin_jpy", side: "sell", price: 100, startAmount: 1 }),
          buildOrder({ id: "2", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 }),
          buildOrder({ id: "3", pair: "btc\nevil_jpy", side: "sell", price: 100, startAmount: 1 }),
        ],
      }),
      {
        path: null,
        fillMode: "market",
        feeRate: 0,
        logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
        fetchCandles: async (pair) => {
          fetched.push(pair);
          return { success: true, data: [candle(T0 + MIN, 110, 110, 50, 105)] };
        },
      },
    );
    await store.tick(T0 + 2 * MIN);
    expect(fetched).toEqual(["btc_jpy"]);
    expect(activeOrders(store.state()).map((o) => o.pair)).toEqual([
      "../../admin_jpy",
      "btc\nevil_jpy",
    ]);
    // 生の pair はログへ出さない。改行を含むペアは JSON が \n へ逃がすので、
    // 警告 1 件がログの 2 行に割れることはない。
    expect(warnings).toEqual([
      'tick: skipping malformed pair "../../admin_jpy"',
      'tick: skipping malformed pair "btc\\nevil_jpy"',
    ]);
    expect(warnings.every((w) => !/[\u0000-\u001f]/.test(w))).toBe(true);
  });

  // `/_control/tick` で進めた lastTickAt が実時刻より先にあると、取得範囲が
  // (未来, 現在) と逆転する。逆転した範囲では返った足が runTick の窓から全部外れて
  // 1 本も約定しないので、取得ごと飛ばして警告を出す（以前は黙って止まっていた）。
  it("skips the candle fetch and warns when lastTickAt is ahead of now", async () => {
    const fetched: Array<[string, number, number]> = [];
    const warnings: string[] = [];
    const store = new SessionStore(
      buildState({
        // 時計が 5 時間先にある状態（control の tick で進めた後の形）。
        lastTickAt: new Date(T0 + 5 * 60 * MIN).toISOString(),
        balances: { jpy: 10_000_000 },
        orders: [buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 })],
      }),
      {
        path: null,
        fillMode: "market",
        feeRate: 0,
        logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
        fetchCandles: async (pair, fromMs, toMs) => {
          fetched.push([pair, fromMs, toMs]);
          // 本来なら必ず約定する安い足。取得が走らないことを見たいので中身は関係ない。
          return { success: true, data: [candle(T0 + MIN, 110, 110, 50, 105)] };
        },
      },
    );
    await store.tick(T0 + 2 * MIN);
    // 逆転した範囲の問い合わせは走らない。
    expect(fetched).toEqual([]);
    expect(activeOrders(store.state())).toHaveLength(1);
    expect(warnings).toEqual([
      `tick: lastTickAt "${new Date(T0 + 5 * 60 * MIN).toISOString()}" is ahead of ` +
        `now "${new Date(T0 + 2 * MIN).toISOString()}"; skipping candle fetch`,
    ]);
    expect(warnings.every((w) => !/[\u0000-\u001f]/.test(w))).toBe(true);
  });

  // 戻した時計は状態ファイルにも残す。約定が 0 でも書かないと、再起動で未来の時計を
  // 読み直して同じ空振りを繰り返す。
  it("persists the recovered clock even though nothing filled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bitbank-mock-clock-"));
    try {
      const path = join(dir, "state.json");
      const store = new SessionStore(
        buildState({
          lastTickAt: new Date(T0 + 5 * 60 * MIN).toISOString(),
          balances: { jpy: 10_000_000 },
          orders: [buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 })],
        }),
        {
          path,
          fillMode: "market",
          feeRate: 0,
          fetchCandles: async () => ({ success: true, data: [] }),
        },
      );
      await store.tick(T0 + 2 * MIN);
      const reloaded = await loadState(path, {});
      expect(reloaded.success).toBe(true);
      expect(reloaded.success && reloaded.data?.lastTickAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // 時計が先にあっても、tick の最後で lastTickAt は実時刻に戻る（既存の挙動）。
  // だから警告が出るのはその 1 回だけで、次の tick は今までどおり取得して約定する。
  it("recovers on the next tick once lastTickAt is back to now", async () => {
    const fetched: Array<[string, number, number]> = [];
    const warnings: string[] = [];
    const store = new SessionStore(
      buildState({
        lastTickAt: new Date(T0 + 5 * 60 * MIN).toISOString(),
        balances: { jpy: 10_000_000 },
        orders: [buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 })],
      }),
      {
        path: null,
        fillMode: "market",
        feeRate: 0,
        logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
        fetchCandles: async (pair, fromMs, toMs) => {
          fetched.push([pair, fromMs, toMs]);
          return { success: true, data: [candle(T0 + 3 * MIN, 110, 110, 50, 105)] };
        },
      },
    );
    await store.tick(T0 + 2 * MIN);
    await store.tick(T0 + 4 * MIN);
    expect(fetched).toEqual([["btc_jpy", T0 + 2 * MIN, T0 + 4 * MIN]]);
    expect(activeOrders(store.state())).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});

describe("SessionStore.persist", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-persist-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function readFileState(path: string) {
    const r = await loadState(path);
    if (!r.success) throw new Error(r.error);
    return r.data;
  }

  // 同一の状態ファイルへ並行に書くと、直列化が無いときは古いスナップショットの
  // rename が後から着地してメモリと食い違う。1 回では取りこぼすので複数回試す。
  it("並行発注の後でファイルがメモリと一致する", async () => {
    const TRIALS = 5;
    const ORDERS = 30;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const path = join(dir, `trial-${trial}`, "state.json");
      const { fastify, store, close } = await buildTestServer(
        buildState({ balances: { jpy: 100_000_000 } }),
        {},
        { path },
      );
      try {
        const responses = await Promise.all(
          Array.from({ length: ORDERS }, () =>
            fastify.inject({
              method: "POST",
              url: "/v1/user/spot/order",
              payload: {
                pair: "btc_jpy",
                side: "buy",
                type: "limit",
                price: 5_000_000,
                amount: 0.001,
              },
            }),
          ),
        );
        for (const res of responses) expect(res.json().success).toBe(1);

        const memory = store.state();
        expect(memory.orders).toHaveLength(ORDERS);
        expect(memory.nextOrderSeq).toBe(ORDERS + 1);

        const onDisk = await readFileState(path);
        expect({
          trial,
          orders: onDisk?.orders.length,
          nextOrderSeq: onDisk?.nextOrderSeq,
        }).toEqual({ trial, orders: ORDERS, nextOrderSeq: ORDERS + 1 });
        expect(onDisk).toEqual(memory);
      } finally {
        await close();
      }
    }
  });

  // 発注だけの並行より経路が広い（取消は cancelOrder、部分約定は control 経由の fillOrder）。
  // どれも store.replace() → store.persist() の順に走るので、直列化が崩れると
  // 約定済みの注文が UNFILLED のままのファイルに巻き戻る。1 回では取りこぼすので複数回試す。
  it("発注・取消・部分約定を混ぜた同時実行の後でファイルがメモリと一致する", async () => {
    const TRIALS = 5;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const path = join(dir, `mixed-${trial}`, "state.json");
      const { fastify, store, close } = await buildTestServer(
        buildState({ balances: { jpy: 1_000_000_000 } }),
        {},
        { path, fillMode: "manual", controlEnabled: true },
      );
      try {
        const place = () =>
          fastify.inject({
            method: "POST",
            url: "/v1/user/spot/order",
            payload: {
              pair: "btc_jpy",
              side: "buy",
              type: "limit",
              price: 5_000_000,
              amount: 0.002,
            },
          });
        // 種の注文を直列に 30 本（id 1..30）置いてから、同時実行を始める。
        for (let i = 0; i < 30; i += 1) expect((await place()).json().success).toBe(1);

        const jobs: Promise<unknown>[] = [];
        for (let i = 0; i < 10; i += 1) jobs.push(place()); // 新規発注（id 31..40）
        for (let i = 1; i <= 10; i += 1) {
          jobs.push(
            fastify.inject({
              method: "POST",
              url: "/v1/user/spot/cancel_order",
              payload: { pair: "btc_jpy", order_id: i },
            }),
          );
        }
        for (let i = 11; i <= 20; i += 1) {
          // 0.002 のうち 0.001 だけ約定させて PARTIALLY_FILLED にする。
          jobs.push(
            fastify.inject({
              method: "POST",
              url: `/_control/orders/${i}/fill`,
              payload: { amount: 0.001 },
            }),
          );
        }
        for (let i = 21; i <= 30; i += 1) {
          jobs.push(fastify.inject({ method: "POST", url: `/_control/orders/${i}/fill` }));
        }
        const responses = (await Promise.all(jobs)) as Array<{ statusCode: number }>;
        expect(responses.filter((r) => r.statusCode >= 400)).toEqual([]);

        const memory = store.state();
        expect(memory.orders).toHaveLength(40);

        // 状態ファイルを読み直して、全注文の status / 約定量 / trade を突き合わせる。
        const onDisk = await readFileState(path);
        const shape = (s: PaperState) => ({
          nextOrderSeq: s.nextOrderSeq,
          nextTradeSeq: s.nextTradeSeq,
          balances: s.balances,
          orders: s.orders.map((o) => [o.id, o.status, o.executedAmount, o.executedNotional]),
          trades: s.trades.map((t) => [t.tradeId, t.orderId, t.amount]),
        });
        expect({ trial, ...shape(onDisk!) }).toEqual({ trial, ...shape(memory) });
        expect(onDisk).toEqual(memory);
      } finally {
        await close();
      }
    }
  });

  // 2xx だけでは書き込みの成否を判定できないので、失敗を store が覚える。
  // 状態ファイルのパスをディレクトリにすると rename が必ず EISDIR で落ちる。
  describe("書き出しの失敗の記録", () => {
    it("成功しかしていなければ初期値のまま", async () => {
      const path = join(dir, "health-ok", "state.json");
      const store = new SessionStore(buildState(), { path, fillMode: "manual" });
      await store.persist();
      expect(store.persistHealth()).toEqual({ lastError: null, consecutiveFailures: 0 });
    });

    it("失敗のたびに連続失敗数が増え、直近の失敗を覚える", async () => {
      const path = join(dir, "health-ng", "state.json");
      await mkdir(path, { recursive: true }); // ここをディレクトリにすると rename が落ちる
      const warnings: string[] = [];
      const store = new SessionStore(buildState(), {
        path,
        fillMode: "manual",
        logger: { warn: (m) => warnings.push(m), info: () => {} },
      });

      await store.persist();
      const first = store.persistHealth();
      expect(first.consecutiveFailures).toBe(1);
      expect(first.lastError?.message).toContain("EISDIR");
      expect(Date.parse(first.lastError!.at)).not.toBeNaN();

      store.replace(buildState({ nextOrderSeq: 2 }));
      await store.persist();
      expect(store.persistHealth().consecutiveFailures).toBe(2);
      expect(warnings).toHaveLength(2);
    });

    it("書き込みが成功すると連続失敗数は 0 に戻るが、直近の失敗は残る", async () => {
      const path = join(dir, "health-recover", "state.json");
      await mkdir(path, { recursive: true });
      const store = new SessionStore(buildState(), { path, fillMode: "manual" });
      await store.persist();
      expect(store.persistHealth().consecutiveFailures).toBe(1);

      // ディレクトリを退けると書けるようになる。
      await rm(path, { recursive: true });
      store.replace(buildState({ nextOrderSeq: 2 }));
      await store.persist();

      const health = store.persistHealth();
      expect(health.consecutiveFailures).toBe(0);
      // 一度でも失敗したことは消さない（その実験の記録は疑ってかかる必要がある）。
      expect(health.lastError?.message).toContain("EISDIR");
    });

    // 閉じた標準出力への console.warn は EPIPE で投げる。ここで投げ返すと、発注が
    // メモリ上では成立しているのにルートが封筒でない 500 を返し、クライアントの再送が
    // 二重注文になる。書き込みが失敗しても 2xx を返すのがここの約束。
    it("logger が投げても persist は解決し、失敗は記録されている", async () => {
      const path = join(dir, "health-throw", "state.json");
      await mkdir(path, { recursive: true });
      const store = new SessionStore(buildState(), {
        path,
        fillMode: "manual",
        logger: { warn: () => { throw new Error("logger が壊れている"); }, info: () => {} },
      });

      await expect(store.persist()).resolves.toBeUndefined();
      expect(store.persistHealth().consecutiveFailures).toBe(1);
      expect(store.persistHealth().lastError?.message).toContain("EISDIR");
    });

    // 指摘の本質は応答が壊れること。ルート越しに固定する。
    it("logger が投げても互換ルートは封筒の 2xx を返す", async () => {
      const path = join(dir, "health-route", "state.json");
      await mkdir(path, { recursive: true });
      const { fastify, store, close } = await buildTestServer(
        buildState({ balances: { jpy: 100_000_000 } }),
        {},
        {
          path,
          fillMode: "manual",
          logger: { warn: () => { throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); }, info: () => {} },
        },
      );
      try {
        const res = await fastify.inject({
          method: "POST",
          url: "/v1/user/spot/order",
          payload: { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.001 },
        });
        // 封筒でない 500 が返ると、発注がメモリ上では成立しているのにクライアントは
        // 失敗と見て再送し、二重注文になる。
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(1);
        expect(store.state().orders).toHaveLength(1);
        // 書けていないことは control から分かる。
        expect(store.persistHealth().consecutiveFailures).toBe(1);
      } finally {
        await close();
      }
    });

    // fs のエラーは対象のパスを生のまま含み、パスは BITBANK_MOCK_STATE_PATH 由来。
    it("改行を含むパスでも警告が 1 行に収まる", async () => {
      const evil = join(dir, "a\n2026-01-01 FAKE LOG LINE", "state.json");
      await mkdir(evil, { recursive: true });
      const warnings: string[] = [];
      const store = new SessionStore(buildState(), {
        path: evil,
        fillMode: "manual",
        logger: { warn: (m) => warnings.push(m), info: () => {} },
      });

      await store.persist();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.split("\n")).toHaveLength(1);
      expect(warnings[0]).toContain("FAKE LOG LINE");
    });
  });

  it("重なった persist() は 1 本にまとめるが最後の 1 本は必ず着地する", async () => {
    for (let trial = 0; trial < 5; trial += 1) {
      const path = join(dir, `coalesce-${trial}`, "state.json");
      const store = new SessionStore(buildState(), { path, fillMode: "manual" });
      const waits: Promise<void>[] = [];
      saveStateCalls.count = 0;
      for (let i = 1; i <= 20; i += 1) {
        store.replace(
          buildState({
            nextOrderSeq: i,
            updatedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
          }),
        );
        waits.push(store.persist());
      }
      await Promise.all(waits);
      // 20 本の persist() が 1 本の書き込みにまとまる（途中の 19 本は捨てる）。
      expect(saveStateCalls.count).toBe(1);
      expect(await readFileState(path)).toEqual(store.state());
    }
  });

  // 発注 → 部分約定 → 取消 の系列を書き出し、読み直した store と突き合わせる。
  it("発注・部分約定・取消の後、読み直した状態が一致する", async () => {
    const path = join(dir, "restart", "state.json");
    const { fastify, store, close } = await buildTestServer(
      buildState({ balances: { jpy: 100_000_000 } }),
      {},
      { path, fillMode: "manual", controlEnabled: true },
    );
    let before;
    try {
      const created = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.004 },
      });
      const orderId = String(created.json().data.order_id);

      const filled = await fastify.inject({
        method: "POST",
        url: `/_control/orders/${orderId}/fill`,
        payload: { amount: 0.001 },
      });
      expect(filled.statusCode).toBe(200);

      const canceled = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/cancel_order",
        payload: { pair: "btc_jpy", order_id: Number(orderId) },
      });
      expect(canceled.json().data.status).toBe("CANCELED_PARTIALLY_FILLED");
      before = store.state();
    } finally {
      await close();
    }

    // 再起動を模して store を作り直す。
    const reloaded = await loadOrInitDefault(1_000_000, { path, fillMode: "manual" });
    const after = reloaded.state();
    expect(after).toEqual(before);
    expect(after.orders.map((o) => [o.id, o.status, o.executedAmount, o.executedNotional])).toEqual(
      before.orders.map((o) => [o.id, o.status, o.executedAmount, o.executedNotional]),
    );
    expect(after.trades).toEqual(before.trades);
    expect(after.orders[0]?.status).toBe("CANCELED_PARTIALLY_FILLED");
    expect(after.orders[0]?.executedAmount).toBe(0.001);
    expect(after.trades).toHaveLength(1);
  });
});
