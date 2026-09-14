import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { invariantViolations, preconditionViolations } from "./invariants.ts";
import {
  DEFAULT_TAKER_FEE_RATE,
  issuedSeqOf,
  PaperStateSchema,
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

/**
 * 移行で重複した注文 id を振り直す採番器を作る。同じ id が初めて来たらそのまま通し、
 * 2 件目からは入力のどの id とも既に配った id とも重ならない最小の 10 進表記を配る。
 *
 * **これは壊れた状態の修復ではなく変換の一部である。** v1 / v2 の `openOrders` と `history` は
 * それぞれ別の配列で、移行は両者を 1 本の `orders` へ積み直す。積み方を決めるのは移行であり、
 * 衝突しない id を振ることはその一部にあたる（v3 の壊れた state ファイルは修復せず落とす。
 * `loadState()` の項を参照）。重複を残したまま起動させると、`replaceOrder()` が id 一致の
 * 全件を置き換えるせいで不変量 4 が破れ、`runTick()` は 500 になり、先頭が終端レコードなら
 * 取消も約定もできない注文が残る。warn で知らせても利用者にできることが無い。
 *
 * id を保つのは先に積まれる方、すなわち `openOrders` 側である。まだ生きている注文の id は
 * 取消に使えなければならないので、履歴側より優先する。
 *
 * 配る側を 1 から探すのは、入力の id が大きくても採番が安全整数を超えないようにするため。
 */
function makeOrderIdAssigner(v2: PaperStateV2): (id: string) => string {
  // 入力に現れる id は、まだ出力へ積んでいなくても避ける。避けないと後ろの
  // `openOrders` / `history` が持つ id を先に配ってしまい、重複が戻ってくる。
  const reserved = new Set<string>([
    ...v2.openOrders.map((o) => o.id),
    ...v2.history.map((h) => h.id),
  ]);
  const used = new Set<string>();
  let next = 1;
  return (id) => {
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    let fresh = String(next);
    while (reserved.has(fresh) || used.has(fresh)) {
      next += 1;
      fresh = String(next);
    }
    next += 1;
    used.add(fresh);
    return fresh;
  };
}

function migrateToV3(v2: PaperStateV2): PaperState {
  const orders: OrderRecord[] = [];
  const trades: TradeRecord[] = [];
  const assignOrderId = makeOrderIdAssigner(v2);

  for (const o of v2.openOrders) {
    orders.push({
      id: assignOrderId(o.id),
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
    // trade は同じ注文を指さなければならない（不変量 5）。振り直した id をそのまま使う。
    const orderId = assignOrderId(h.id);
    orders.push({
      id: orderId,
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
      orderId,
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

  // 採番の初期値は「配り得る id の最大 + 1」。判定は `preconditionViolations()` と同じ
  // `issuedSeqOf()` を使う。ずれると移行の出力が自分の検査に落ちるため。
  // `"007"` のように配られない表記の id は最大に数えない（`String(seq)` と一致しないので
  // 採番がぶつかることはなく、数えると採番を無用に大きくする）。
  const maxIssued = orders.reduce((max, o) => {
    const n = issuedSeqOf(o.id);
    return n != null && n > max ? n : max;
  }, 0);

  return {
    version: 3,
    createdAt: v2.createdAt,
    updatedAt: v2.updatedAt,
    initialJpy: v2.initialJpy,
    lastTickAt: v2.lastTickAt,
    balances: v2.balances,
    orders,
    trades,
    nextOrderSeq: maxIssued + 1,
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
//
// 空文字は「未設定」として扱う（`??` ではなく真偽で見る）。src/server/config.ts の
// `controlToken()` / `listenHost()` / `fillMode()` と、すぐ上の `BITBANK_MOCK_STATE_PATH` が
// どれも空文字を未設定として落とすので、ここだけ空文字を値として受けると読み取りがずれる。
// `BITBANK_MOCK_HOME=""` を値として受けると `join("", ...)` が相対パス
// `sessions/<id>/state.json` になり、同じ env でも起動した作業ディレクトリごとに
// 別の状態ファイルを掴む（README が既定として書く `~/.bitbank-mock` からも黙って外れる）。
export function defaultStatePath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.BITBANK_MOCK_STATE_PATH) return env.BITBANK_MOCK_STATE_PATH;
  const root = env.BITBANK_MOCK_HOME || join(homedir(), ".bitbank-mock");
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
 *
 * 不変量の**前提**（注文 id / trade id の一意性、採番と既存 id の整合、`startAmount > 0`）も
 * 同じ扱いで検査する（`preconditionViolations()`）。前提の違反は不変量とは別の関数・別の
 * メッセージにする。6 本は Nyx 仕様書 D1 と対応していて本数も内容も変えないからで、
 * 前提を混ぜると 7 本目に見える。
 *
 * 前提を破って落とすときは不変量の違反を並べない。`invariantViolations()` の文字列は注文を
 * id で指すので、id が重複している状態ではどのレコードの話か定まらないためである。
 *
 * 移行の側は id の重複を作らない（`makeOrderIdAssigner()`）ので、重複を抱えた状態はここを
 * 必ず fail-closed で通る。移行の warn に残る前提の破れは、`startAmount == 0` のように
 * 移行の入力そのものが持っていたものだけで、どれも起動後に 500 や書き換えを起こさない。
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
    const logger = opts.logger ?? noopLogger;

    const preconditions = preconditionViolations(state);
    if (preconditions.length > 0) {
      // 違反文字列は preconditionViolations が返すまま出す（どの前提のどの id かを残す）。
      const detail = `${preconditions.length} violation(s): ${preconditions.join("; ")}`;
      if (!migrated) {
        return { success: false, error: `paper state violates invariant preconditions: ${detail}` };
      }
      logger.warn(`migrated paper state violates invariant preconditions: ${detail}`);
    }

    const violations = invariantViolations(state, opts.feeRate ?? DEFAULT_TAKER_FEE_RATE);
    if (violations.length > 0) {
      // 違反文字列は invariantViolations が返すまま出す（どの不変量のどの注文かを残す）。
      const detail = `${violations.length} violation(s): ${violations.join("; ")}`;
      if (!migrated) {
        return { success: false, error: `paper state violates invariants: ${detail}` };
      }
      logger.warn(`migrated paper state violates invariants: ${detail}`);
    }
    return { success: true, data: state };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { success: true, data: null };
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `failed to read paper state: ${msg}` };
  }
}

export type SaveStateOptions = {
  /** ディレクトリの fsync が失敗したことを知らせる先。既定は捨てる。 */
  logger?: Logger;
};

/**
 * `rename` が差し替えたディレクトリのエントリをディスクへ落とす。
 *
 * 一時ファイルの中身は `fh.sync()` で落ちているが、`rename` 自体はディレクトリの更新なので、
 * ここを fsync しないと OS ごと落ちた場合に差し替えが失われ、古い `state.json` が残る。
 *
 * **失敗を書き込みの失敗へ昇格させてはいけない。** ディレクトリの fsync はどの環境でも
 * 通るとは限らない（ファイルシステムによっては `EINVAL`、Windows では open 自体が失敗する）。
 * ここで失敗を返すと、今まで書けていた環境が書けなくなる。差し替え自体は済んでいて
 * `state.json` は正しく置かれているので、耐久性が落ちたことだけを呼び出し側へ返す。
 */
async function syncDirectory(dir: string): Promise<Result<true>> {
  try {
    const dh = await open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
    return { success: true, data: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg };
  }
}

/**
 * `PaperState` 全体を状態ファイルへ原子的に書き出す。
 *
 * 一時ファイルを `wx`（既存を開かない）で `0o600` で作り、書いて `fsync` してから `rename`、
 * 最後に親ディレクトリを `fsync` する。読み手が途中の内容を見ることはなく、`rename` の
 * 差し替えは OS ごと落ちても残る。書き込みに失敗したときは自分が作った一時ファイルだけ消す
 * （`open` に失敗した時点では消さない。置かれていたファイルを巻き込まないため）。
 *
 * **戻り値は「状態ファイルが置かれたか」だけを表す。** ディレクトリの `fsync` の失敗も
 * `opts.logger` が投げたことも、ここを `false` にはしない（`syncDirectory()` の項）。
 * この戻り値は呼び出し側が状態の扱いを決める根拠になるので、ログの副作用で反転させない。
 */
export async function saveState(
  path: string,
  state: PaperState,
  opts: SaveStateOptions = {},
): Promise<Result<true>> {
  const data = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  // ディレクトリの fsync の失敗は書き込みの成否と別に持つ。warn は try を出てから呼ぶ
  // （logger が投げても、成立した書き込みを失敗として報告しないため。この戻り値は
  // 呼び出し側が状態の扱いを決める根拠になる）。
  let dirSyncError: string | null = null;
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
    // `rename` はディレクトリの更新なので、ここを fsync しないと OS ごと落ちたときに
    // 差し替えが失われる。失敗しても `state.json` は置かれているので、書き込みは成功の
    // まま返す（一時ファイルは rename で消えているので、後片付けも伴わない）。
    const synced = await syncDirectory(dirname(path));
    if (!synced.success) dirSyncError = synced.error;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: `failed to write paper state: ${msg}` };
  }
  // ここへ来た時点で状態ファイルは置かれている。以降は成否を変えない。
  // ログには生のパスを出さない（改行・制御文字で行を割られないよう JSON で包む）。
  if (dirSyncError !== null) {
    try {
      (opts.logger ?? noopLogger).warn(
        `state dir fsync failed for ${JSON.stringify(dirname(path))}: ${dirSyncError}; ` +
          "the rename may not survive an OS crash",
      );
    } catch {
      // logger が投げても握り潰す。`npm run dev | head` のように標準出力が閉じた後の
      // console.warn は EPIPE で投げるので、これは想像上の経路ではない。書き込みは
      // 既に成立していて、ログに出せなかったことでその事実を覆してはならない。
    }
  }
  return { success: true, data: true };
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
