import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadState } from "../../src/engine/persist.ts";
import { activeOrders } from "../../src/engine/state.ts";
import { loadOrInitDefault, SessionStore } from "../../src/store/session.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { buildTestServer, stubFetchCandles } from "../routes/helpers.ts";

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

  it("重なった persist() は 1 本にまとめるが最後の 1 本は必ず着地する", async () => {
    for (let trial = 0; trial < 5; trial += 1) {
      const path = join(dir, `coalesce-${trial}`, "state.json");
      const store = new SessionStore(buildState(), { path, fillMode: "manual" });
      const waits: Promise<void>[] = [];
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
