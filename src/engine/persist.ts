import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { invariantViolations } from "./invariants.ts";
import {
  DEFAULT_TAKER_FEE_RATE,
  PaperStateSchema,
  parseNumericId,
  type OrderRecord,
  type PaperState,
  type TradeRecord,
} from "./state.ts";
import { noopLogger, type Logger, type Result } from "./types.ts";

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

export type LoadStateOptions = {
  /**
   * 不変量 6（拘束は残高を超えない）の判定に使う手数料率。買いの拘束額は手数料込みなので、
   * SessionStore が使う値と揃えないと境界の注文で判定がずれる。既定は公称テイカー手数料。
   */
  feeRate?: number;
  /** 移行した状態の違反を知らせる先。既定は捨てる。 */
  logger?: Logger;
};

/**
 * 状態ファイルを読み、v3 へ移行してから不変量を検査する。
 *
 * zod スキーマは形しか見ないので、`executedAmount > startAmount` や負の残高のように
 * 不変量だけを破る状態ファイルはスキーマを通ってしまう。docs/fidelity.md の
 * 「状態の不変量（PaperState v3）」は Nyx 仕様書 D1 の前提なので、破れた状態のまま
 * 応答を返すと（負の `remaining_amount` など）先方の証明の前提が崩れる。壊れた JSON と
 * 同じ fail-closed に揃え、違反を見つけたら起動させない。
 *
 * ただし fail-closed にするのは**もともと v3 だったファイルだけ**。v1 / v2 から移行した
 * 結果が不変量を破る場合は warn を出して起動する（docs/fidelity.md の同節に記載）。
 * 移行の入力は本モックが書いたとは限らず、ここで落とすと旧 state の利用者が
 * 起動できなくなるため。移行後の状態が書き戻されれば、次回の起動では v3 として検査される。
 */
export async function loadState(
  path: string,
  opts: LoadStateOptions = {},
): Promise<Result<PaperState | null>> {
  try {
    const buf = await readFile(path, "utf-8");
    const parsed = PaperStateAnySchema.safeParse(JSON.parse(buf));
    if (!parsed.success) {
      return { success: false, error: `invalid paper state: ${parsed.error.message}` };
    }
    const migrated = parsed.data.version !== 3;
    const state = migrateToLatest(parsed.data);
    const violations = invariantViolations(state, opts.feeRate ?? DEFAULT_TAKER_FEE_RATE);
    if (violations.length > 0) {
      // 違反文字列は invariantViolations が返すまま出す（どの不変量のどの注文かを残す）。
      const detail = `${violations.length} violation(s): ${violations.join("; ")}`;
      if (!migrated) {
        return { success: false, error: `paper state violates invariants: ${detail}` };
      }
      const logger = opts.logger ?? noopLogger;
      logger.warn(`migrated paper state violates invariants: ${detail}`);
    }
    return { success: true, data: state };
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
