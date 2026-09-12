import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  PaperStateSchema,
  parseNumericId,
  type OrderRecord,
  type PaperState,
  type TradeRecord,
} from "./state.ts";
import type { Result } from "./types.ts";

const PaperHistoryEntrySchemaV2 = z.object({
  id: z.string(),
  pair: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]),
  amount: z.number(),
  fillPrice: z.number(),
  feeJpy: z.number(),
  filledAt: z.string(),
});

const OpenOrderSchemaV2 = z.object({
  id: z.string(),
  pair: z.string(),
  side: z.enum(["buy", "sell"]),
  type: z.literal("limit"),
  price: z.number(),
  amount: z.number(),
  createdAt: z.string(),
});

const PaperStateSchemaV1 = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  initialJpy: z.number(),
  balances: z.record(z.string(), z.number()),
  history: z.array(PaperHistoryEntrySchemaV2),
});

const PaperStateSchemaV2 = z.object({
  version: z.literal(2),
  createdAt: z.string(),
  updatedAt: z.string(),
  initialJpy: z.number(),
  balances: z.record(z.string(), z.number()),
  history: z.array(PaperHistoryEntrySchemaV2),
  lastTickAt: z.string(),
  openOrders: z.array(OpenOrderSchemaV2),
});

const PaperStateAnySchema = z.discriminatedUnion("version", [
  PaperStateSchemaV1,
  PaperStateSchemaV2,
  PaperStateSchema,
]);

type PaperStateV2 = z.infer<typeof PaperStateSchemaV2>;

function migrateToV2(parsed: z.infer<typeof PaperStateSchemaV1>): PaperStateV2 {
  return {
    version: 2,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    initialJpy: parsed.initialJpy,
    balances: parsed.balances,
    history: parsed.history,
    lastTickAt: parsed.updatedAt,
    openOrders: [],
  };
}

function migrateToV3(v2: PaperStateV2): PaperState {
  const orders: OrderRecord[] = [];
  const trades: TradeRecord[] = [];

  for (const o of v2.openOrders) {
    orders.push({
      id: o.id,
      pair: o.pair,
      side: o.side,
      type: "limit",
      price: o.price,
      startAmount: o.amount,
      executedAmount: 0,
      executedNotional: 0,
      status: "UNFILLED",
      orderedAt: o.createdAt,
      canceledAt: null,
      updatedAt: o.createdAt,
    });
  }

  let tradeSeq = 1;
  for (const h of v2.history) {
    orders.push({
      id: h.id,
      pair: h.pair,
      side: h.side,
      type: h.type,
      price: h.type === "limit" ? h.fillPrice : null,
      startAmount: h.amount,
      executedAmount: h.amount,
      executedNotional: h.fillPrice * h.amount,
      status: "FULLY_FILLED",
      orderedAt: h.filledAt,
      canceledAt: null,
      updatedAt: h.filledAt,
    });
    trades.push({
      tradeId: String(tradeSeq),
      orderId: h.id,
      pair: h.pair,
      side: h.side,
      type: h.type,
      amount: h.amount,
      price: h.fillPrice,
      feeQuote: h.feeJpy,
      makerTaker: h.type === "limit" ? "maker" : "taker",
      executedAt: h.filledAt,
    });
    tradeSeq += 1;
  }

  const numericIds = orders
    .map((o) => parseNumericId(o.id))
    .filter((n): n is number => n != null);

  return {
    version: 3,
    createdAt: v2.createdAt,
    updatedAt: v2.updatedAt,
    initialJpy: v2.initialJpy,
    lastTickAt: v2.lastTickAt,
    balances: v2.balances,
    orders,
    trades,
    nextOrderSeq: numericIds.reduce((max, n) => (n > max ? n : max), 0) + 1,
    nextTradeSeq: tradeSeq,
  };
}

export function migrateToLatest(parsed: z.infer<typeof PaperStateAnySchema>): PaperState {
  if (parsed.version === 3) return parsed;
  if (parsed.version === 1) return migrateToV3(migrateToV2(parsed));
  return migrateToV3(parsed);
}

// env を引数で受け取るのは src/server/config.ts の env 読み取りに合わせるため。
// 既定は process.env なので呼び出し側は変えなくてよい。
export function defaultStatePath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.BITBANK_MOCK_STATE_PATH) return env.BITBANK_MOCK_STATE_PATH;
  const root = env.BITBANK_MOCK_HOME ?? join(homedir(), ".bitbank-mock");
  return join(root, "sessions", sessionId, "state.json");
}

export async function loadState(path: string): Promise<Result<PaperState | null>> {
  try {
    const buf = await readFile(path, "utf-8");
    const parsed = PaperStateAnySchema.safeParse(JSON.parse(buf));
    if (!parsed.success) {
      return { success: false, error: `invalid paper state: ${parsed.error.message}` };
    }
    return { success: true, data: migrateToLatest(parsed.data) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { success: true, data: null };
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `failed to read paper state: ${msg}` };
  }
}

export async function saveState(path: string, state: PaperState): Promise<Result<true>> {
  const data = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    // "wx" は既存ファイルを開かない。一時ファイル名は pid + 乱数なので通常は衝突せず、
    // この排他は置かれていたファイル（シンボリックリンクを含む）の上書きだけを防ぐ。
    const fh = await open(tmp, "wx", 0o600);
    try {
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, path);
    } catch (e) {
      // 自分で作った一時ファイルだけ片付ける。open に失敗した時点では消さない。
      await unlink(tmp).catch(() => {});
      throw e;
    }
    return { success: true, data: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `failed to write paper state: ${msg}` };
  }
}

export async function deleteState(path: string): Promise<Result<true>> {
  try {
    await unlink(path);
    return { success: true, data: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { success: true, data: true };
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `failed to delete paper state: ${msg}` };
  }
}
