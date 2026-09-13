import type { Candle } from "../engine/candles.ts";
import { defaultFetchCandles } from "../engine/candles.ts";
import { runTick } from "../engine/match.ts";
import { defaultStatePath, loadState, saveState } from "../engine/persist.ts";
import {
  activeOrders,
  DEFAULT_TAKER_FEE_RATE,
  nowIso,
  pairAssets,
  type PaperState,
} from "../engine/state.ts";
import type { FetchCandles, Logger } from "../engine/types.ts";
import { noopLogger } from "../engine/types.ts";
import { fillMode, type FillMode } from "../server/config.ts";

const LATEST_LOOKBACK_MS = 5 * 60_000;

export type SessionStoreOptions = {
  fetchCandles?: FetchCandles;
  path?: string | null;
  feeRate?: number;
  logger?: Logger;
  fillMode?: FillMode;
};

export class SessionStore {
  private _state: PaperState;
  private readonly fetchCandles: FetchCandles;
  private readonly path: string | null;
  readonly feeRate: number;
  readonly fillMode: FillMode;
  private readonly logger: Logger;
  /** 直列化した書き込みの末尾。次の書き込みはこれが解決してから始める。 */
  private persistTail: Promise<void> = Promise.resolve();
  /** 予約済みでまだ始まっていない書き込み。重なった persist() はここへ合流する。 */
  private persistPending: Promise<void> | null = null;

  constructor(state: PaperState, opts: SessionStoreOptions = {}) {
    this._state = state;
    this.fetchCandles = opts.fetchCandles ?? defaultFetchCandles();
    this.path = opts.path === undefined ? defaultStatePath("default") : opts.path;
    this.feeRate = opts.feeRate ?? DEFAULT_TAKER_FEE_RATE;
    this.fillMode = opts.fillMode ?? fillMode();
    this.logger = opts.logger ?? noopLogger;
  }

  state(): PaperState {
    return this._state;
  }

  replace(next: PaperState): void {
    this._state = next;
  }

  async tick(nowMs: number = Date.now()): Promise<Map<string, Candle[]>> {
    const result = new Map<string, Candle[]>();
    if (this.fillMode === "manual") return result;
    const pairs = new Set(activeOrders(this._state).map((o) => o.pair));
    const lastMs = Date.parse(this._state.lastTickAt);
    const tickFrom = this._state.lastTickAt;
    let totalFilled = 0;
    for (const pair of pairs) {
      // 状態ファイルから読んだ注文のペアは検証を通っていない（PaperStateSchema は文字種を
      // 見ない）。文字種が不正なペアは外向きに問い合わせても意味が無く、足が返ってくると
      // fillOrder が INVALID_PAIR を返して applyFill が throw する。ここで落とす。
      // ログには生の pair を出さない（改行・制御文字で行を割られないよう JSON で包む）。
      if (!pairAssets(pair)) {
        this.logger.warn(`tick: skipping malformed pair ${JSON.stringify(pair)}`);
        result.set(pair, []);
        continue;
      }
      const r = await this.fetchCandles(pair, lastMs, nowMs);
      if (!r.success) {
        this.logger.warn(`tick: fetchCandles failed for ${pair}: ${r.error}`);
        result.set(pair, []);
        continue;
      }
      result.set(pair, r.data);
      const sr = runTick({ ...this._state, lastTickAt: tickFrom }, {
        candles: r.data,
        nowMs,
        pair,
        feeRate: this.feeRate,
        logger: this.logger,
      });
      if (!sr.success) {
        this.logger.warn(`tick: runTick failed for ${pair}: ${sr.error}`);
        continue;
      }
      totalFilled += sr.data.filled.length;
      this._state = sr.data.state;
    }
    const ts = new Date(nowMs).toISOString();
    this._state = { ...this._state, lastTickAt: ts, updatedAt: ts };
    if (totalFilled > 0) await this.persist();
    return result;
  }

  async getLatestPrice(pair: string, nowMs: number = Date.now()): Promise<number | null> {
    const r = await this.fetchCandles(pair, nowMs - LATEST_LOOKBACK_MS, nowMs);
    if (!r.success || r.data.length === 0) return null;
    return r.data.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b)).close;
  }

  /**
   * 状態ファイルへ書き出す。saveState 自体は一時ファイル + rename で原子的だが、
   * 複数の書き込みが重なると古いスナップショットを持った rename が後から着地して
   * 状態が巻き戻る。ここで直列化して、そうならないようにする。
   *
   * 保証: await が返った時点で、ファイルは呼び出し時点の状態と同じか、それより
   * 新しい状態を反映している。書き込みの開始は必ず persist() の呼び出しより後で、
   * そのとき `this._state` を読むため、呼び出し時点の状態を取りこぼすことはない。
   *
   * 重なった呼び出しは 1 本にまとめる（途中のスナップショットは捨てる）。
   * ただし最後の 1 本は必ず着地する。
   */
  async persist(): Promise<void> {
    if (!this.path) return;
    // 予約済みの書き込みがあるなら、それを待てば自分より新しい状態が書かれる。
    if (this.persistPending) return this.persistPending;
    // 直前の書き込みが失敗しても連鎖は止めない（失敗は write() が warn 済み）。
    const pending = this.persistTail.catch(() => {}).then(() => {
      // 実書き込みへ移る前に予約を解除する。以降の persist() は次の 1 本を予約する。
      if (this.persistPending === pending) this.persistPending = null;
      return this.write();
    });
    this.persistPending = pending;
    this.persistTail = pending;
    return pending;
  }

  private async write(): Promise<void> {
    if (!this.path) return;
    // saveState は同期的に JSON 化するので、ここで読んだ状態がそのまま着地する。
    const r = await saveState(this.path, this._state);
    if (!r.success) this.logger.warn(`persist failed: ${r.error}`);
  }
}

export async function loadOrInitDefault(
  initialJpy: number,
  opts: SessionStoreOptions = {},
): Promise<SessionStore> {
  const path = opts.path === undefined ? defaultStatePath("default") : opts.path;
  let state: PaperState;
  if (path) {
    const r = await loadState(path);
    if (!r.success) throw new Error(r.error);
    state = r.data ?? freshState(initialJpy);
  } else {
    state = freshState(initialJpy);
  }
  return new SessionStore(state, opts);
}

export function freshState(initialJpy: number): PaperState {
  const now = nowIso();
  return {
    version: 3,
    createdAt: now,
    updatedAt: now,
    initialJpy,
    balances: { jpy: initialJpy },
    lastTickAt: now,
    orders: [],
    trades: [],
    nextOrderSeq: 1,
    nextTradeSeq: 1,
  };
}
