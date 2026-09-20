import { describe, expect, it } from "vitest";
import { OFFICIAL_PAIRS } from "../../src/engine/pairs.ts";
import { activeOrders } from "../../src/engine/state.ts";
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
