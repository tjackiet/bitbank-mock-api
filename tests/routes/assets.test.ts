import { describe, expect, it } from "vitest";
import { buildOrder, buildState } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";

describe("GET /v1/user/assets", () => {
  const build = setupBuildTestServer();

  /**
   * 残高が無くても必ず出る資産と、その並び。**実装（`KNOWN_ASSETS`）からは導かない。**
   * 実装から組み立てると、実装が変わったときに期待値も一緒に変わって検査にならない。
   */
  const BASELINE_ASSETS = ["jpy", "btc", "eth", "xrp", "ltc", "bcc", "mona", "xlm", "qtum", "bat"];

  /**
   * 残高が無くても必ず出る資産の一覧を固定する（`src/routes/format.ts` の `KNOWN_ASSETS`）。
   *
   * **この 10 個に公式の根拠は無い**（`docs/fidelity.md` の「assets に出る資産」節に
   * 未確定として記録した）。根拠が無いものこそ黙って変わると気づけないので、
   * ここで並びごと固定しておく。実 API を測って変えるときは、この期待値も同じ PR で動かす。
   *
   * **`src/engine/pairs.ts` の `OFFICIAL_PAIRS`（62 ペア＝48 資産）とは別の集合**である。
   * ペアを足しても assets の既定は増えない、という非連動をここで示す。
   */
  it("残高が無くても固定の 10 資産を返し、残高のある資産だけが後ろに足される", async () => {
    const { fastify } = await build(buildState({ balances: {} }));
    const read = async () => {
      const res = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: { assets: { asset: string }[] } };
      return body.data.assets.map((a) => a.asset);
    };

    expect(await read()).toEqual(BASELINE_ASSETS);

    // 一覧に無い資産は、残高を持って初めて現れる（公式ペア一覧に居ても現れない）。
    // **並びまで見る。** `formatAssets()` は Set の挿入順で組むので固定の 10 資産が先、
    // 状態由来の資産が後になる。件数と包含だけだと、先頭に紛れ込んでも通ってしまう。
    const { fastify: withSol } = await build(buildState({ balances: { sol: 2 } }));
    const res = await withSol.inject({ method: "GET", url: "/v1/user/assets" });
    const assets = (res.json() as { data: { assets: { asset: string }[] } }).data.assets.map(
      (a) => a.asset,
    );
    expect(assets).toEqual([...BASELINE_ASSETS, "sol"]);
  });

  it("returns assets with locked/free split", async () => {
    const state = buildState({
      balances: { jpy: 1_000_000, btc: 0.5 },
      orders: [buildOrder({ id: "1", side: "buy", price: 5_000_000, startAmount: 0.1 })],
    });
    const { fastify } = await build(state);
    const res = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      success: number;
      data: {
        assets: {
          asset: string;
          free_amount: string;
          locked_amount: string;
          onhand_amount: string;
        }[];
      };
    };
    expect(body.success).toBe(1);
    const jpy = body.data.assets.find((a) => a.asset === "jpy");
    const btc = body.data.assets.find((a) => a.asset === "btc");
    expect(jpy).toBeDefined();
    expect(btc).toBeDefined();
    expect(Number(jpy?.onhand_amount)).toBe(1_000_000);
    expect(Number(jpy?.locked_amount)).toBeGreaterThan(0);
    expect(Number(jpy?.free_amount)).toBeLessThan(1_000_000);
    expect(Number(btc?.onhand_amount)).toBe(0.5);
  });

  /**
   * 拘束額は `SessionStore` の料率で計算する。**既定の料率では検査にならない。**
   *
   * `formatAssets()` の `feeRate` に既定値があったころ、`src/routes/assets.ts` は渡し忘れて
   * いた。それでも既定の料率どうしだと値が一致するので、typecheck もテスト 437 件も通った。
   * 料率を動かして初めて差が出る（下の 48,800 JPY）。
   *
   * ずれると実害がある。発注ガードは `availableOf()` を store の料率で引くので、
   * 応答の `free_amount` を見て発注量を決める利用側が、通ると見た注文を `60001` で断られる。
   */
  it("locked_amount は store の料率で計算する（既定値へ落とさない）", async () => {
    const state = buildState({
      balances: { jpy: 100_000_000 },
      orders: [buildOrder({ id: "1", side: "buy", price: 1_000_000, startAmount: 1 })],
    });
    const { fastify } = await build(state, {}, { feeRate: 0.05 });
    const res = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    const body = res.json() as { data: { assets: { asset: string; locked_amount: string }[] } };
    const jpy = body.data.assets.find((a) => a.asset === "jpy");

    // 1,000,000 × 1 × (1 + 0.05)
    expect(jpy?.locked_amount).toBe("1050000.0000");
    // 既定料率 0.0012 なら 1,001,200。渡し忘れるとこちらになる。
    expect(jpy?.locked_amount).not.toBe("1001200.0000");
  });

  // `constructor` は Object.prototype が持つ名前なので、素の {} から引くと関数が返り、
  // free_amount が "NaN"、onhand_amount が関数のソース文字列になって応答に漏れていた。
  it("formats an asset named like an Object.prototype key as a decimal string", async () => {
    const state = buildState({
      balances: { jpy: 1_000_000, constructor: 5 },
      orders: [
        buildOrder({ id: "1", side: "sell", pair: "constructor_jpy", price: 100, startAmount: 2 }),
      ],
    });
    const { fastify } = await build(state);
    const res = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        assets: {
          asset: string;
          free_amount: string;
          locked_amount: string;
          onhand_amount: string;
        }[];
      };
    };
    const asset = body.data.assets.find((a) => a.asset === "constructor");
    expect(asset).toBeDefined();
    expect(asset?.onhand_amount).toBe("5.00000000");
    expect(asset?.locked_amount).toBe("2.00000000");
    expect(asset?.free_amount).toBe("3.00000000");
  });

  it("returns fixed-precision decimal strings without floating point dust", async () => {
    // 0.001 BTC @ 15,000,000 の買い指値 6 本。手数料込みの拘束額が
    // 倍精度で 90108.00000000001 になり、残余に塵が出ていた条件。
    const state = buildState({
      balances: { jpy: 100_000 },
      orders: Array.from({ length: 6 }, (_, i) =>
        buildOrder({
          id: String(i + 1),
          side: "buy",
          price: 15_000_000,
          startAmount: 0.001,
        }),
      ),
    });
    const { fastify } = await build(state);
    const res = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        assets: {
          asset: string;
          free_amount: string;
          amount_precision: number;
          locked_amount: string;
          onhand_amount: string;
        }[];
      };
    };
    const jpy = body.data.assets.find((a) => a.asset === "jpy");
    expect(jpy?.amount_precision).toBe(4);
    // Number() に通さず文字列のまま比較する。
    expect(jpy?.onhand_amount).toBe("100000.0000");
    expect(jpy?.locked_amount).toBe("90108.0000");
    expect(jpy?.free_amount).toBe("9892.0000");

    // 宣言した桁ちょうどの 10 進文字列であること（全資産）。
    for (const a of body.data.assets) {
      expect(a.amount_precision).toBe(a.asset === "jpy" ? 4 : 8);
      const digits = `[0-9]{${a.amount_precision}}`;
      const shape = new RegExp(`^-?[0-9]+\\.${digits}$`);
      expect(a.free_amount).toMatch(shape);
      expect(a.onhand_amount).toMatch(shape);
      expect(a.locked_amount).toMatch(shape);
    }

    // 応答の中で free == onhand - locked が文字列として成り立つこと。
    // 倍精度を経由しないよう BigInt で 10 進のまま引く。
    for (const a of body.data.assets) {
      const d = a.amount_precision;
      expect(a.free_amount).toBe(
        unitsToFixed(toUnits(a.onhand_amount, d) - toUnits(a.locked_amount, d), d),
      );
    }
  });

  it("keeps fixed-decimal form for balances whose scaled units exceed 2^53", async () => {
    // /reset は有限・非負なら上限なく残高を受ける。桁を掛けた値を number で
    // 持つと 1e21 で指数表記に落ち、"1.e+21" のような壊れた金額になっていた。
    const state = buildState({ balances: { jpy: 1e17, btc: 12_345_678.9 } });
    const { fastify } = await build(state);
    const res = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { assets: { asset: string; free_amount: string; onhand_amount: string }[] };
    };
    const jpy = body.data.assets.find((a) => a.asset === "jpy");
    const btc = body.data.assets.find((a) => a.asset === "btc");
    expect(jpy?.onhand_amount).toBe("100000000000000000.0000");
    expect(jpy?.free_amount).toBe("100000000000000000.0000");
    expect(btc?.onhand_amount).toBe("12345678.90000000");
    for (const a of body.data.assets) {
      expect(a.onhand_amount).not.toMatch(/[eE]/);
      expect(a.free_amount).not.toMatch(/[eE]/);
    }
  });

  it("returns exactly the field set the official asset response defines", async () => {
    const { fastify } = await build(buildState({ balances: { jpy: 1_000_000, btc: 0.5 } }));
    const res = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { assets: Record<string, unknown>[] } };

    // rest-api.md「return user's asset list」の応答表。network_list は jpy でだけ省略される。
    const OFFICIAL_FIELDS = [
      "asset",
      "free_amount",
      "amount_precision",
      "onhand_amount",
      "locked_amount",
      "withdrawing_amount",
      "withdrawal_fee",
      "stop_deposit",
      "stop_withdrawal",
      "collateral_ratio",
    ];

    expect(body.data.assets.length).toBeGreaterThan(0);
    for (const a of body.data.assets) {
      const isJpy = a.asset === "jpy";
      const expected = isJpy ? OFFICIAL_FIELDS : [...OFFICIAL_FIELDS, "network_list"];
      // 欠落と余剰の両方を落とす。toMatchObject ではドキュメントに無いキーが通ってしまう。
      expect({ asset: a.asset, keys: Object.keys(a).sort() }).toEqual({
        asset: a.asset,
        keys: [...expected].sort(),
      });

      // 未実装の値は 0。桁は同じ応答が宣言する amount_precision に揃える。
      const zero = `0.${"0".repeat(a.amount_precision as number)}`;
      expect(a.withdrawing_amount).toBe(zero);
      expect(a.collateral_ratio).toBe("0");
      expect(a.withdrawal_fee).toEqual(
        isJpy ? { under: zero, over: zero, threshold: zero } : { min: zero, max: zero },
      );
      if (!isJpy) expect(a.network_list).toEqual([]);
    }
  });
});

/** 固定桁の 10 進文字列を最小単位の BigInt にする。倍精度を経由しない。 */
function toUnits(s: string, digits: number): bigint {
  const negative = s.startsWith("-");
  const [int, frac = ""] = (negative ? s.slice(1) : s).split(".");
  const units = BigInt(int + frac.padEnd(digits, "0"));
  return negative ? -units : units;
}

/** 期待値側で桁つき文字列を組み立てる（実装とは独立に書く）。 */
function unitsToFixed(units: bigint, digits: number): string {
  const sign = units < 0n ? "-" : "";
  const padded = (units < 0n ? -units : units).toString().padStart(digits + 1, "0");
  const cut = padded.length - digits;
  return `${sign}${padded.slice(0, cut)}.${padded.slice(cut)}`;
}

/**
 * 残高の表示が**切り捨て**であることを固定する。
 *
 * **根拠は 2026-09-17 の実測**。実 API に約定しない指値買い（`xrp_jpy`、price 101、
 * amount 9.9009）を 1 本置いて `locked_amount` の増分を測ったところ、厳密値
 * `999.9909 × 1.0012 = 1001.19088908` に対し **`1001.1908`** が返った。
 * 四捨五入なら `1001.1909` になるので、切り捨てだと分かる。
 *
 * この観測は**同時に「拘束額が taker 料率の手数料を含む」ことも示している**
 * （差 1.1999 JPY = 建玉額の 0.12%）。指値（maker）注文なのに taker 料率だった。
 * 詳細は `docs/fidelity.md` の「拘束額」節と「残高の桁」節。
 *
 * 変更前は四捨五入だったが、**それを固定するテストは 1 つも無かった**
 * （切り捨てへ変えても 385 件すべて通ってしまった）ので、ここで塞ぐ。
 */
describe("残高の桁は切り捨て", () => {
  const build = setupBuildTestServer();

  const lockedJpy = async (price: number, startAmount: number) => {
    const state = buildState({
      balances: { jpy: 10_000_000 },
      orders: [buildOrder({ id: "1", side: "buy", price, startAmount })],
    });
    const { fastify } = await build(state);
    const body = (await fastify.inject({ method: "GET", url: "/v1/user/assets" })).json() as {
      data: { assets: Array<{ asset: string; locked_amount: string }> };
    };
    return body.data.assets.find((a) => a.asset === "jpy")?.locked_amount;
  };

  // 実測そのものの再現。厳密値 1001.19088908 → 切り捨てで 1001.1908。
  it("実 API で観測した値を再現する（四捨五入なら 1001.1909 になる）", async () => {
    expect(await lockedJpy(101, 9.9009)).toBe("1001.1908");
  });

  // **切り捨ては倍精度の塵に弱い。** 四捨五入なら吸収されていた塵が、切り捨てでは
  // 表示桁を 1 つ下げる。`50 × 0.575 × 1.0012` は数学的に 28.7845 ちょうどだが
  // 倍精度では 28.784499999999998 で、素朴に切り捨てると 28.7844 になる。
  // `toMinimumUnits()` が `toPrecision(15)` で寄せてから桁を合わせることを見る。
  it("倍精度の塵で表示桁が 1 つ下がらない", async () => {
    expect(await lockedJpy(50, 0.575)).toBe("28.7845");
  });

  // 5 桁目が 5 以上でも切り上げないことを、大きさの違う 3 例で見る。
  // どれも四捨五入なら最後の桁が 1 つ上がるので、丸め方を確実に区別できる。
  it.each([
    // price, amount, 厳密値, 切り捨て（四捨五入ならこうならない）
    [101, 0.0007, "0.07078484", "0.0707"],
    [137, 1.2345, "169.32945180", "169.3294"],
    [137, 7.7777, "1066.82355388", "1066.8235"],
  ])("price=%s amount=%s（厳密 %s）は切り捨てて %s", async (price, amount, _exact, want) => {
    expect(await lockedJpy(price as number, amount as number)).toBe(want);
  });
});
