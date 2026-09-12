import { describe, expect, it } from "vitest";
import { buildOrder, buildState } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";

describe("GET /v1/user/assets", () => {
  const build = setupBuildTestServer();

  it("returns assets with locked/free split", async () => {
    const state = buildState({
      balances: { jpy: 1_000_000, btc: 0.5 },
      orders: [
        buildOrder({ id: "1", side: "buy", price: 5_000_000, startAmount: 0.1 }),
      ],
    });
    const { fastify } = await build(state);
    const res = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: number; data: { assets: { asset: string; free_amount: string; locked_amount: string; onhand_amount: string }[] } };
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
        })),
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
