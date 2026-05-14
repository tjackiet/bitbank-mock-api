import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTick } from "./engine/match.ts";
import { loadState, saveState } from "./engine/persist.ts";
import { genId, nowIso, type PaperState } from "./engine/state.ts";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "bitbank-mock-smoke-"));
  const path = join(dir, "state.json");
  const now = nowIso();
  const state: PaperState = {
    version: 2,
    createdAt: now,
    updatedAt: now,
    initialJpy: 1_000_000,
    balances: { jpy: 1_000_000 },
    history: [],
    lastTickAt: now,
    openOrders: [
      {
        id: genId(),
        pair: "btc_jpy",
        side: "buy",
        type: "limit",
        price: 5_000_000,
        amount: 0.001,
        createdAt: now,
      },
    ],
  };
  await saveState(path, state);
  const t0 = Date.parse(now);
  const r = runTick(state, {
    candles: [
      {
        open: 5_010_000,
        high: 5_020_000,
        low: 4_999_000,
        close: 5_005_000,
        vol: 0.1,
        timestamp: t0 + 60_000,
      },
    ],
    nowMs: t0 + 120_000,
    feeRate: 0.0012,
    logger: { warn: (m) => console.warn(m), info: (m) => console.log(m) },
  });
  await saveState(path, r.state);
  const reloaded = await loadState(path);
  console.log("filled:", r.filled.length);
  console.log("balance jpy:", r.state.balances.jpy);
  console.log("balance btc:", r.state.balances.btc);
  console.log("reload ok:", reloaded.success);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
