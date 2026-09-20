import { describe, expect, it } from "vitest";
import { OFFICIAL_PAIRS } from "../../src/engine/pairs.ts";
import { activeOrders } from "../../src/engine/state.ts";
import { MAX_ACTIVE_ORDERS } from "../../src/routes/create-order.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";
import {
  OFFICIAL_CREATE_ORDER_STATUSES,
  orderShape,
  UNIMPLEMENTED_ORDER_FIELDS,
} from "./official-fields.ts";

describe("POST /v1/user/spot/order", () => {
  const build = setupBuildTestServer();

  it("creates a limit buy and adds to open orders", async () => {
    const { fastify, store } = await build(buildState({ balances: { jpy: 10_000_000 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { order_id: number; status: string } };
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("UNFILLED");
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  it("rejects limit buy when funds insufficient", async () => {
    const { fastify } = await build(buildState({ balances: { jpy: 100 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(60001);
  });

  // `constructor_jpy` は公式一覧に無いので、残高を見る前にペアの検査で 40017 になる。
  //
  // かつてここは 60001（残高不足）を期待していた。`constructor` を base に持つペアでは
  // availableOf が NaN を返し、`NaN < amount` が false になるため残高ゼロの売りが受理されて
  // いた、という回帰の番人だったためである。**その回帰自体は engine 側で押さえている**
  // （`tests/engine/state.test.ts` の computeLocked / availableOf、`invariants.test.ts`、
  // `persist.test.ts`、`transitions.test.ts`）。いずれも state を直接組むのでこの経路の
  // 検査を通らず、状態ファイル由来の `constructor_jpy` という本来の侵入口を塞ぎ続ける。
  // ここで見るのは「ペアの検査が残高の検査より先に効くこと」だけにする。
  it("rejects a pair outside the official list before checking the balance", async () => {
    const { fastify, store } = await build(buildState({ balances: { jpy: 1_000_000 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: {
        pair: "constructor_jpy",
        amount: "999",
        price: "100",
        side: "sell",
        type: "limit",
      },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(40017);
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  it("fills market buy at latest candle close", async () => {
    const now = Date.now();
    const { fastify, store } = await build(buildState({ balances: { jpy: 10_000_000 } }), {
      btc_jpy: [candle(now - 60_000, 4_990_000, 5_010_000, 4_980_000, 5_000_000)],
    });
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", side: "buy", type: "market" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: number;
      data: { status: string; price?: string; average_price: string };
    };
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("FULLY_FILLED");
    expect(body.data.price).toBeUndefined();
    expect(Number(body.data.average_price)).toBe(5_000_000);
    expect(store.state().balances.btc).toBe(0.001);
    expect(store.state().trades).toHaveLength(1);
  });

  // pair の欠落は 30009（"Missing asset."）。GET order / orders_info と揃える。
  // この経路も 2026-09-17 に実 API で実測済み（pair が無いと取引できる先が無いので
  // 注文は成立しない）。空白だけの値は下の別テストで 40017 を見る。
  it.each([[undefined], [""]])("returns 30009 when pair is missing: %p", async (pair) => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: {
        ...(pair === undefined ? {} : { pair }),
        amount: "0.001",
        price: "5000000",
        side: "buy",
        type: "limit",
      },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(30009);
  });

  // 空白だけの `pair` は「欠落」ではなく「不正な値」。`isMissing()` が trim しないので
  // `pairAssets()` まで進んで 40017 になる。**実 API も 40017 を返すことを実測した**
  // （2026-09-17）。偶然そうなっていたのではなく一致している、という記録。
  it("returns 40017 when pair is whitespace only", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "   ", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(40017);
  });

  it("rejects invalid pair", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(40017);
  });

  it("does not tick existing orders when the pair is malformed", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const { fastify, store } = await build(
      buildState({
        balances: { jpy: 10_000 },
        lastTickAt: new Date(t0).toISOString(),
        orders: [buildOrder({ id: "1", side: "buy", price: 100, startAmount: 1 })],
      }),
      { btc_jpy: [candle(t0 + 60_000, 110, 110, 50, 105)] },
    );
    const before = structuredClone(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(40017);
    expect(store.state()).toEqual(before);
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  // 記号入りのペアは pairAssets が弾く。既存の分岐（create-order.ts の
  // `if (!pairAssets(pair)) return err(ErrorCode.INVALID_ASSET)`）がそのまま 40017 を返す。
  it.each([["../../admin_jpy"], ["btc?a=1_jpy"], ["btc#frag_jpy"]])(
    "rejects a pair with URL metacharacters: %s",
    async (pair) => {
      const { fastify } = await build();
      const res = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: { pair, amount: "0.001", price: "5000000", side: "buy", type: "limit" },
      });
      const body = res.json() as { success: number; data: { code: number } };
      expect(body.success).toBe(0);
      expect(body.data.code).toBe(40017);
    },
  );

  // 記号入りのペアで発注しても、外向きの足取得が 1 回も起きないこと。
  // market は getLatestPrice を呼ぶ前に弾く必要がある。
  it.each([["../../admin_jpy"], ["btc?a=1_jpy"], ["btc#frag_jpy"]])(
    "never fetches candles for a pair with URL metacharacters: %s",
    async (pair) => {
      const pairs: string[] = [];
      const state = buildState({ balances: { jpy: 10_000_000 } });
      const store = new SessionStore(state, {
        path: null,
        fillMode: "market",
        fetchCandles: async (p) => {
          pairs.push(p);
          return { success: true, data: [] };
        },
      });
      const fastify = await buildServer({ store, logger: false, controlEnabled: false });
      try {
        for (const type of ["limit", "market"] as const) {
          const res = await fastify.inject({
            method: "POST",
            url: "/v1/user/spot/order",
            payload: {
              pair,
              amount: "0.001",
              side: "buy",
              type,
              ...(type === "limit" ? { price: "5000000" } : {}),
            },
          });
          const body = res.json() as { success: number; data: { code: number } };
          expect(body.data.code).toBe(40017);
        }
        expect(pairs).toEqual([]);
      } finally {
        await fastify.close();
      }
    },
  );

  // ホワイトリストにしたことの証明。文字種は正しいが公式一覧に無いペアは 40017 で断り、
  // 注文を作らない。**この経路の 40017 は実測ではなく外挿**（照会 4 経路で `xxx_yyy` が
  // 40017 だったことから。発注は実弾になるので実 API では測れない）。
  // 根拠と留保は `docs/fidelity.md` の「ペア」節にある。
  it("rejects a well-formed pair that is not in the official pair list", async () => {
    const { fastify, store } = await build(buildState({ balances: { jpy: 10_000_000 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "foo_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(40017);
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  // 一覧にあるペアは通る（上の拒否が「全部断っている」わけではないことの対照）。
  // **発注停止のペアは対照に使えない**——`70017` で断るようになったので、ここは
  // 停止していないペアだけを並べる（停止ペアの側は下の「発注停止のペア」の describe が見る）。
  it("accepts pairs in the official list that are not order-suspended", async () => {
    const { fastify, store } = await build(buildState({ balances: { jpy: 10_000_000, btc: 100 } }));
    for (const pair of ["xrp_jpy", "ltc_jpy"]) {
      // 価格は既定桁（btc_jpy の 0 桁）に合わせる。未登録ペアの桁を仮置きする決定は
      // 今回変えていないので、`xrp_jpy` の価格も整数でないと 20003 で弾かれる。
      const res = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: { pair, amount: "1", price: "1", side: "buy", type: "limit" },
      });
      expect((res.json() as { success: number }).success).toBe(1);
    }
    expect(activeOrders(store.state()).map((o) => o.pair)).toEqual(["xrp_jpy", "ltc_jpy"]);
  });

  it("rejects a malformed pair on market before looking up a price", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc", amount: "0.001", side: "buy", type: "market" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(40017);
  });

  it("rejects bad payload", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "-1", side: "buy", type: "limit", price: "5000000" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(20003);
  });

  it("returns 30001 when amount is missing", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", price: "5000000", side: "buy", type: "limit" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30001);
  });

  it("returns 30013 when side is missing", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", type: "limit" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30013);
  });

  it("returns 30015 when type is missing", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30015);
  });

  it("returns 30012 when limit price is missing", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", side: "buy", type: "limit" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.data.code).toBe(30012);
  });

  it("returns 60004 when amount exceeds pair digits", async () => {
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.00001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(60004);
  });

  /**
   * 非正の `price` / `amount` を断ることを wire の応答で固定する。
   *
   * **`price` を守っているのは `placeOrder` の `refPrice <= 0` 1 行だけである。**
   * `src/schemas/requests.ts` は `amount` に `refine((n) => n > 0)` を持つのに
   * `price` には持たないので（`price: numStr.optional()`）、0 はスキーマを素通りする。
   * その 1 行を `< 0` に変えると**価格 0 の注文が `success: 1` で通り、拘束額も 0 になる**
   * ——それでも 458 件が 1 件も落ちなかった（隔離コピーで実測）。
   *
   * 欠落（`30012` / `30001`）とは別のコードになることも併せて見る。0 を「未指定」と
   * 同じ扱いに寄せると、利用側はこの 2 つを区別できなくなる。
   */
  it.each([
    ["price が 0", { price: 0 }],
    ["price が負", { price: -1 }],
    ["amount が 0", { amount: 0 }],
    ["amount が負", { amount: -0.001 }],
  ])("%s なら 20003 で断り、注文を作らない", async (_label, override) => {
    const { fastify, store } = await build(buildState({ balances: { jpy: 10_000_000 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: {
        pair: "btc_jpy",
        amount: 0.001,
        price: 5_000_000,
        side: "buy",
        type: "limit",
        ...override,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(20003);
    // 応答だけでなく状態も見る。断ったのに注文が残っていたら意味がない。
    expect(store.state().orders).toEqual([]);
  });

  it("0 と欠落は別のコードで断る（20003 と 30012 / 30001）", async () => {
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000 } }));
    const post = async (payload: Record<string, unknown>) => {
      const res = await fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload });
      return (res.json() as { data: { code: number } }).data.code;
    };
    const base = { pair: "btc_jpy", side: "buy", type: "limit" };

    expect(await post({ ...base, amount: 0.001, price: 0 })).toBe(20003);
    expect(await post({ ...base, amount: 0.001 })).toBe(30012);
    expect(await post({ ...base, amount: 0, price: 5_000_000 })).toBe(20003);
    expect(await post({ ...base, price: 5_000_000 })).toBe(30001);
  });

  it("market の 0 数量も 20003 で断る（価格は市場から取る経路）", async () => {
    // market は `price` を送らず `marketPrice` を使うので、`amount` 側だけが残る。
    const { fastify, store } = await build(buildState({ balances: { jpy: 10_000_000 } }), {
      btc_jpy: [
        candle(Date.parse("2026-01-01T00:01:00.000Z"), 5_000_000, 5_000_000, 5_000_000, 5_000_000),
      ],
    });
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: 0, side: "buy", type: "market" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(20003);
    expect(store.state().orders).toEqual([]);
  });
});

describe("POST /v1/user/spot/order official field set", () => {
  const build = setupBuildTestServer();

  it("returns exactly the fields the official create-order response defines (limit)", async () => {
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    const s = orderShape(body.data, { type: "limit", canceled: false });
    expect(s.actual).toEqual(s.expected);
    expect(OFFICIAL_CREATE_ORDER_STATUSES).toContain(body.data.status);
    for (const f of UNIMPLEMENTED_ORDER_FIELDS) expect(body.data).not.toHaveProperty(f);
  });

  it("returns exactly the fields the official create-order response defines (market)", async () => {
    const now = Date.now();
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000 } }), {
      btc_jpy: [candle(now - 60_000, 4_990_000, 5_010_000, 4_980_000, 5_000_000)],
    });
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", side: "buy", type: "market" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    const s = orderShape(body.data, { type: "market", canceled: false });
    expect(s.actual).toEqual(s.expected);
    expect(OFFICIAL_CREATE_ORDER_STATUSES).toContain(body.data.status);
    for (const f of UNIMPLEMENTED_ORDER_FIELDS) expect(body.data).not.toHaveProperty(f);
  });
});

/**
 * 発注停止のペア（公式 `pairs.md` の "Order suspended flag (delisted)" が `true` の 18 ペア）
 * への新規発注を `70017` で断る（`docs/fidelity.md` の「ペア」節）。
 *
 * **fail-closed であることが要点。** 停止ペアへ実際に発注したとき実 API が何を返すかは
 * 実測していないが、成功させると本番で成立しない注文について利用側が「成功する」という
 * 契約を学習してしまう。断る側に倒した（**v0.1.0 からの改訂**。改訂前は成功させていた）。
 *
 * **断るのは新規発注だけ。** 照会は `tests/routes/pair-whitelist.test.ts`、既存注文の取消は
 * `tests/routes/cancel-order.test.ts` が、停止ペアでも通ることを固定している。公式が
 * `stop_order` と `stop_order_and_cancel` を書き分けているためで（`rest-api.md:1696-1697`）、
 * **この非対称を「揃っている方が自然だから」で崩さないこと。**
 */
describe("発注停止のペア", () => {
  const build = setupBuildTestServer();

  /** 停止ペアと非停止ペアを表から導く。手で書くと表を直したときに食い違う。 */
  const suspended = OFFICIAL_PAIRS.filter((p) => p.orderSuspended).map((p) => p.pair);
  const allowed = OFFICIAL_PAIRS.filter((p) => !p.orderSuspended).map((p) => p.pair);

  it("導出が空振りしていない（18 ペアが停止、残りは発注できる）", () => {
    expect(suspended).toHaveLength(18);
    expect(allowed).toHaveLength(OFFICIAL_PAIRS.length - 18);
    // Plan A の `btc_jpy` は停止側に入らない（入ったらシナリオが丸ごと止まる）。
    expect(suspended).not.toContain("btc_jpy");
  });

  it("停止ペアへの指値は 70017 で断り、状態を変えない", async () => {
    const { fastify, store } = await build(buildState({ balances: { jpy: 10_000_000, btc: 100 } }));
    const before = structuredClone(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "xrp_btc", amount: "1", price: "1", side: "sell", type: "limit" },
    });
    // 互換ルートなので HTTP は 200 + 封筒（`src/routes/envelope.ts` の `err`）。
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(70017);
    expect(store.state()).toEqual(before);
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  /**
   * 成行でも断る。**価格を引きに行く前**に断ることを、足を 1 本も渡さないことで示す
   * （引きに行っていれば `getLatestPrice()` が `null` を返して `70001` になる）。
   */
  it("停止ペアへの成行も 70017 で断る（価格を引く前）", async () => {
    const { fastify, store } = await build(buildState({ balances: { jpy: 10_000_000, btc: 100 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "xrp_btc", amount: "1", side: "sell", type: "market" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(70017);
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  it.each(suspended)("%s は発注できない", async (pair) => {
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000, btc: 100 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair, amount: "1", price: "1", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(70017);
  });

  /**
   * 断る側だけ見ていると「全部断っている」実装でも通る。非停止ペアが通ることを併せて見る。
   *
   * 数量・価格は既定桁（`btc_jpy` の数量 4 桁・価格 0 桁）に合わせる。61 ペアの桁を
   * 仮置きする決定は今回変えていない（`docs/fidelity.md` の「数量・価格の精度」節）。
   */
  it.each(allowed)("%s は従来どおり発注できる", async (pair) => {
    const { fastify } = await build(buildState({ balances: { jpy: 10_000_000, btc: 100 } }));
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair, amount: "1", price: "1", side: "buy", type: "limit" },
    });
    expect((res.json() as { success: number }).success).toBe(1);
  });

  /**
   * **停止ペアの active な注文を持つ state を壊さない。** この規則より前に書かれた状態
   * ファイルには停止ペアの注文が残り得る。発注時の検査であって状態の妥当性検査ではない
   * ので、読み込みも照会も通る（取り除く手段は `cancel-order.test.ts` が見る）。
   */
  it("停止ペアの active な注文を持つ state を読み込める", async () => {
    const state = buildState({
      balances: { jpy: 1_000_000, btc: 100 },
      orders: [buildOrder({ id: "7", pair: "xrp_btc", side: "buy", price: 1, startAmount: 1 })],
    });
    const { fastify, store } = await build(state);
    expect(activeOrders(store.state()).map((o) => o.id)).toEqual(["7"]);
    const res = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=xrp_btc&order_id=7",
    });
    const body = res.json() as { success: number; data: { status: string } };
    expect(body.success).toBe(1);
    expect(body.data.status).toBe("UNFILLED");
  });
});

/**
 * 同時に持てる未約定注文の本数の上限（`docs/fidelity.md` の「同時未約定注文の上限」節）。
 *
 * 上限の値 30 は公式のエラー定義が文言に持つ（`errors.md:202` "Too many Simultaneous orders,
 * current limit is 30."）。**適用条件は公式ドキュメントから読み取れない**——この番号は
 * `errors.md` にしか無く、`rest-api.md` の Create new order には出てこない。**数える単位を
 * 口座全体にしたのは推測である。**
 *
 * **境界の両側を見る。** 30 本ちょうどが置けることを見ないと、「全部断る」実装でも
 * `60011` のテストだけは通ってしまう（`cancel_orders` の `40015` と同じ理由）。
 *
 * **`cancel_orders` の 30 件上限（`40015`）とは別の制限。** 同じ 30 だが数える対象が違い、
 * あちらは `tests/routes/cancel-order.test.ts` が固定している。
 */
describe("同時未約定注文の上限", () => {
  const build = setupBuildTestServer();

  /** 上限を数えるぶんの残高を持つ状態。1 本 0.001 btc × 5,000,000 円 ≒ 5,006 円の拘束。 */
  const richState = () => buildState({ balances: { jpy: 10_000_000, btc: 100 } });

  const place = (fastify: Awaited<ReturnType<typeof build>>["fastify"], price = 5_000_000) =>
    fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: {
        pair: "btc_jpy",
        amount: "0.001",
        price: String(price),
        side: "buy",
        type: "limit",
      },
    });

  const codeOf = (res: Awaited<ReturnType<typeof place>>) =>
    (res.json() as { success: number; data: { code?: number } }).data.code;

  it("上限の値は公式のエラー定義どおり 30 本である", () => {
    expect(MAX_ACTIVE_ORDERS).toBe(30);
  });

  it(`${MAX_ACTIVE_ORDERS} 本ちょうどは置ける`, async () => {
    const { fastify, store } = await build(richState(), {}, { fillMode: "manual" });
    for (let i = 0; i < MAX_ACTIVE_ORDERS; i++) {
      const res = await place(fastify);
      expect((res.json() as { success: number }).success).toBe(1);
    }
    expect(activeOrders(store.state())).toHaveLength(MAX_ACTIVE_ORDERS);
  });

  it(`${MAX_ACTIVE_ORDERS + 1} 本目は 60011 で断り、状態を一切変えない`, async () => {
    const { fastify, store } = await build(richState(), {}, { fillMode: "manual" });
    for (let i = 0; i < MAX_ACTIVE_ORDERS; i++) await place(fastify);
    // 「注文が増えていない」だけでなく「状態が一切変わらない」ことを見る。判定は
    // `store.tick()` より前にあるので、採番（`nextOrderSeq`）も `updatedAt` も動かない。
    const before = structuredClone(store.state());
    const res = await place(fastify);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(60011);
    expect(store.state()).toEqual(before);
    expect(activeOrders(store.state())).toHaveLength(MAX_ACTIVE_ORDERS);
    expect(store.state().orders).toHaveLength(MAX_ACTIVE_ORDERS);
  });

  it("1 本取り消して 29 本にすると、また置ける", async () => {
    const { fastify, store } = await build(richState(), {}, { fillMode: "manual" });
    for (let i = 0; i < MAX_ACTIVE_ORDERS; i++) await place(fastify);
    expect(codeOf(await place(fastify))).toBe(60011);

    const canceled = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: 1 },
    });
    expect((canceled.json() as { success: number }).success).toBe(1);
    // 終端（`CANCELED_UNFILLED`）は `STATUS_KIND` の `"terminal"` なので数に入らない。
    expect(activeOrders(store.state())).toHaveLength(MAX_ACTIVE_ORDERS - 1);
    expect(store.state().orders).toHaveLength(MAX_ACTIVE_ORDERS);

    expect((await place(fastify)).json()).toMatchObject({ success: 1 });
    expect(activeOrders(store.state())).toHaveLength(MAX_ACTIVE_ORDERS);
  });

  /**
   * **部分約定した注文は数に入る。** `PARTIALLY_FILLED` は `STATUS_KIND` の `"active"` で、
   * `activeOrders()` が返す。数え方を `activeOrders()` に寄せたことの要点がここで、
   * 「未約定 = `UNFILLED` だけ」と読み替えた実装ならこのテストが落ちる。
   *
   * 部分約定は `/_control/orders/:id/fill` で起こす（残量の一部だけを約定させる）。
   * state を手で組むと trade 記録と `executedAmount` の整合（不変量 5）を自分で保つ必要があり、
   * 実際の遷移を通したほうが確かである。
   */
  it("部分約定した注文も数に入る", async () => {
    const { fastify, store } = await build(
      richState(),
      {},
      {
        fillMode: "manual",
        controlEnabled: true,
      },
    );
    for (let i = 0; i < MAX_ACTIVE_ORDERS; i++) await place(fastify);

    const filled = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { amount: 0.0005 },
    });
    expect(filled.statusCode).toBe(200);
    const target = store.state().orders.find((o) => o.id === "1");
    expect(target?.status).toBe("PARTIALLY_FILLED");
    expect(activeOrders(store.state())).toHaveLength(MAX_ACTIVE_ORDERS);

    expect(codeOf(await place(fastify))).toBe(60011);

    // 残量まで約定させて終端（`FULLY_FILLED`）にすると枠が空く。
    const rest = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: {},
    });
    expect(rest.statusCode).toBe(200);
    expect(store.state().orders.find((o) => o.id === "1")?.status).toBe("FULLY_FILLED");
    expect(activeOrders(store.state())).toHaveLength(MAX_ACTIVE_ORDERS - 1);
    expect((await place(fastify)).json()).toMatchObject({ success: 1 });
  });

  /**
   * **`INACTIVE` は数に入らない**（`STATUS_KIND` の `"pending"`）。Plan A に `INACTIVE` へ
   * 到達する経路は無いので、状態を直接組んで固定する。ここを `"active"` 側に読み替えた
   * 実装はこのテストで落ちる。
   */
  it("INACTIVE の注文は数に入らない", async () => {
    const orders = Array.from({ length: MAX_ACTIVE_ORDERS }, (_, i) =>
      buildOrder({ id: String(i + 1), status: "INACTIVE" }),
    );
    const { fastify, store } = await build(
      buildState({ balances: { jpy: 10_000_000 }, orders }),
      {},
      { fillMode: "manual" },
    );
    expect(activeOrders(store.state())).toHaveLength(0);
    expect((await place(fastify)).json()).toMatchObject({ success: 1 });
  });

  /**
   * **単位は口座全体で、ペアで分けない**（推測。`docs/fidelity.md` の
   * 「同時未約定注文の上限」節）。公式の文言が "Simultaneous orders" でペアに言及しないうえ、
   * 口座全体の方が制限が強く fail-closed 側に倒れる。
   *
   * **Plan A の契約範囲（`btc_jpy` の指値）ではこの区別は付かない**——付かないからこそ、
   * どちらを選んだかをテストで固定しておく。
   */
  it("別のペアの未約定注文も同じ 1 本として数える", async () => {
    const { fastify, store } = await build(
      buildState({ balances: { jpy: 10_000_000, btc: 100 } }),
      {},
      { fillMode: "manual" },
    );
    for (let i = 0; i < MAX_ACTIVE_ORDERS; i++) {
      const res = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: { pair: "xrp_jpy", amount: "1", price: "1", side: "buy", type: "limit" },
      });
      expect((res.json() as { success: number }).success).toBe(1);
    }
    expect(activeOrders(store.state())).toHaveLength(MAX_ACTIVE_ORDERS);
    // `btc_jpy` は 1 本も無いが、口座全体で 30 本あるので断る。
    expect(codeOf(await place(fastify))).toBe(60011);
  });

  /**
   * **成行の新規発注も検査を通る。** その場で全量約定して active には残らないが、
   * 受ける時点では 1 本の新規注文である。実 API が成行を数から除くかは分からない
   * （`docs/fidelity.md` の「同時未約定注文の上限」節）。
   */
  it("上限に達していると成行も 60011 で断る", async () => {
    const orders = Array.from({ length: MAX_ACTIVE_ORDERS }, (_, i) =>
      buildOrder({ id: String(i + 1), price: 5_000_000, startAmount: 0.001 }),
    );
    const { fastify, store } = await build(
      buildState({ balances: { jpy: 10_000_000 }, orders }),
      {
        btc_jpy: [
          candle(
            Date.parse("2026-01-01T00:01:00.000Z"),
            5_000_000,
            5_000_000,
            5_000_000,
            5_000_000,
          ),
        ],
      },
      { fillMode: "manual" },
    );
    const before = structuredClone(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", side: "buy", type: "market" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(60011);
    expect(store.state()).toEqual(before);
    expect(store.state().trades).toHaveLength(0);
  });

  /**
   * **断ったとき market モードの約定も進まない。** 判定を `store.tick()` より前に置いた
   * 理由そのものを固定する。
   *
   * 上の「状態を一切変えない」テストは `fillMode: "manual"` なので、**判定を `tick()` の
   * 後ろへ動かしても通ってしまう**（manual の `tick()` は何もしない）。ここは market モードで
   * **指値に当たる足を渡す**ので、判定が `tick()` の後ろにあれば 30 本が約定して状態が動く。
   *
   * `cancel_orders` の件数上限（`40015`）のテストも足を渡していないので、この性質を
   * 押さえているのはここだけである。
   */
  it("断るとき market モードの約定も進めない（判定が tick より前）", async () => {
    const t0 = Date.now() - 120_000;
    const orders = Array.from({ length: MAX_ACTIVE_ORDERS }, (_, i) =>
      buildOrder({
        id: String(i + 1),
        price: 5_000_000,
        startAmount: 0.001,
        orderedAt: new Date(t0).toISOString(),
        updatedAt: new Date(t0).toISOString(),
      }),
    );
    const { fastify, store } = await build(
      buildState({
        balances: { jpy: 10_000_000 },
        lastTickAt: new Date(t0).toISOString(),
        orders,
      }),
      // 安値が指値を下回るので、tick が走れば 30 本とも買いに当たる。
      { btc_jpy: [candle(t0 + 60_000, 5_000_000, 5_000_000, 4_900_000, 4_950_000)] },
      // fillMode は既定の "market"（渡さない）。
    );
    const before = structuredClone(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" },
    });
    const body = res.json() as { success: number; data: { code: number } };
    expect(body.success).toBe(0);
    expect(body.data.code).toBe(60011);
    // 1 本も約定していない（`tick()` へ到達していない）。
    expect(store.state()).toEqual(before);
    expect(store.state().trades).toHaveLength(0);
    expect(activeOrders(store.state())).toHaveLength(MAX_ACTIVE_ORDERS);
  });

  /**
   * **上限は発注だけの検査で、状態の妥当性検査ではない。** この規則より前に書かれた状態
   * ファイルには 31 本以上の未約定注文が残り得る。読み込みも照会も取消も通す
   * （`docs/fidelity.md` の「同時未約定注文の上限」節。停止ペアの注文を消せるようにして
   * あるのと同じ理由で、取り除く手段を塞がない）。
   */
  it("31 本の未約定注文を持つ state を読み込め、取消もできる", async () => {
    const orders = Array.from({ length: MAX_ACTIVE_ORDERS + 1 }, (_, i) =>
      buildOrder({ id: String(i + 1), price: 5_000_000, startAmount: 0.001 }),
    );
    const { fastify, store } = await build(
      buildState({ balances: { jpy: 10_000_000 }, orders }),
      {},
      { fillMode: "manual" },
    );
    expect(activeOrders(store.state())).toHaveLength(MAX_ACTIVE_ORDERS + 1);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: 31 },
    });
    expect((res.json() as { success: number }).success).toBe(1);
    expect(activeOrders(store.state())).toHaveLength(MAX_ACTIVE_ORDERS);
  });
});
