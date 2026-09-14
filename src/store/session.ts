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

/**
 * 状態ファイルへの書き出しが今どうなっているか。`GET /_control/state` に添えて返す。
 *
 * 2xx だけでは書き込みの成否を判定できない（`write()` は失敗しても throw しない）ので、
 * 警告ログを読む以外に確かめる手段が無かった。実験中にここを見れば、応答を返した注文が
 * 再起動後に消える状態になっていないかを機械的に判定できる。
 *
 * `lastError` は**成功しても消さない**。一度でも失敗したなら、その実験で取った記録は
 * 疑ってかかる必要があるため。今まさに失敗し続けているかどうかは
 * `consecutiveFailures > 0` で見る。
 */
export type PersistHealth = {
  /** 直近の書き込み失敗。まだ一度も失敗していなければ `null`。 */
  lastError: { at: string; message: string } | null;
  /** 直近の書き込みが連続で失敗した回数。1 回でも成功すると 0 に戻る。 */
  consecutiveFailures: number;
};

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
  /** 書き出しの失敗の記録。`persistHealth()` で読む。 */
  private _persistHealth: PersistHealth = { lastError: null, consecutiveFailures: 0 };

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

  /**
   * 状態ファイルへの書き出しが今どうなっているか（`PersistHealth`）。
   *
   * `path` を持たない store（テストや `path: null`）は書き出し自体をしないので、
   * 初期値のまま動かない。
   */
  persistHealth(): PersistHealth {
    return this._persistHealth;
  }

  async tick(nowMs: number = Date.now()): Promise<Map<string, Candle[]>> {
    const result = new Map<string, Candle[]>();
    if (this.fillMode === "manual") return result;
    const pairs = new Set(activeOrders(this._state).map((o) => o.pair));
    const lastMs = Date.parse(this._state.lastTickAt);
    const tickFrom = this._state.lastTickAt;
    // `/_control/tick` で進めた lastTickAt が実時刻より先にあると、取得範囲
    // (lastMs, nowMs) が逆転する。逆転した範囲で外へ問い合わせても、返った足は
    // runTick の窓（fromMs = min(lastTickAt, nowMs) 以上 nowMs 以下）から全部外れて
    // 1 本も約定しない。無駄な問い合わせなので取得ごと飛ばし、黙って止まらないよう
    // 警告を出す（この後 lastTickAt は nowMs で上書きされるので、次の tick は通る）。
    // ログには生の値を出さない（改行・制御文字で行を割られないよう JSON で包む）。
    const clockAhead = lastMs > nowMs;
    if (clockAhead && pairs.size > 0) {
      this.logger.warn(
        `tick: lastTickAt ${JSON.stringify(tickFrom)} is ahead of now ` +
          `${JSON.stringify(new Date(nowMs).toISOString())}; skipping candle fetch`,
      );
    }
    let totalFilled = 0;
    for (const pair of pairs) {
      if (clockAhead) {
        result.set(pair, []);
        continue;
      }
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
    // 約定が無いときは書かない（互換ルートは読み取りでも tick を回すので、毎回書くと
    // 状態ファイルへの書き込みが要求ごとに起きる）。ただし時計が先にあった回だけは、
    // ここで実時刻へ戻した lastTickAt を残す。残さないと、再起動後にファイルから
    // 未来の時計を読み直して同じ空振りを繰り返す。戻した後は clockAhead が偽になるので、
    // この書き込みが続くことはない。
    if (totalFilled > 0 || clockAhead) await this.persist();
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

  /**
   * 直列化された書き込みの実体。`persist()` からのみ呼ぶ。
   *
   * `saveState` は同期的に JSON 化するので、ここで読んだ `this._state` がそのまま着地する。
   * 書き込みに失敗しても throw しない。`_persistHealth` へ記録して warn を出すだけである。
   * ルートは `await store.persist()` の戻りを見ていないので、ここで投げるとハンドラの
   * 未捕捉例外になり、封筒でない 500 が返る。
   *
   * 応答を返した注文が再起動後に消える経路がここに残る点は `docs/fidelity.md` の
   * 「状態の永続化」の行に記録してある（`docs/plan-lab-mock.md` 10 節の PR 3 で扱う）。
   * 呼び出し側がそれを検知する手段が `persistHealth()` であり、`GET /_control/state` の
   * `persist` として出る。
   */
  private async write(): Promise<void> {
    if (!this.path) return;
    // saveState は同期的に JSON 化するので、ここで読んだ状態がそのまま着地する。
    // logger は、書き込みは成立したがディレクトリの fsync に失敗した場合の warn に使う。
    const r = await saveState(this.path, this._state, { logger: this.logger });
    if (r.success) {
      this._persistHealth = { ...this._persistHealth, consecutiveFailures: 0 };
      return;
    }
    // 記録は warn より先に行い、warn が投げても握り潰す。閉じた標準出力への console.warn は
    // EPIPE で投げるので（`npm run dev | head`）、包まないと **発注はメモリ上で成立している
    // のに、ルートが封筒でない 500 を返す**（実測: `{"statusCode":500,"code":"EPIPE",...}`）。
    // クライアントは失敗と見て再送し、二重注文になる。書き込みが失敗しても 2xx を返すのが
    // ここの約束（docs/fidelity.md の「状態の永続化」）で、ログに出せなかったことで
    // その約束を破ってはならない。saveState 側も同じ扱い。
    this._persistHealth = {
      lastError: { at: nowIso(), message: r.error },
      consecutiveFailures: this._persistHealth.consecutiveFailures + 1,
    };
    try {
      // エラーメッセージは JSON で包む。fs のエラーは対象のパスを生のまま含み
      // （`rename '/a\nb.tmp' -> '/a\nb'`）、パスは BITBANK_MOCK_STATE_PATH 由来なので、
      // 包まないと改行でログ行を割られる。
      this.logger.warn(`persist failed: ${JSON.stringify(r.error)}`);
    } catch {
      // 失敗は既に `_persistHealth` へ記録済みなので、ログに出せなくても見る手段は残る。
    }
  }
}

/**
 * 状態ファイルを読んで SessionStore を作る。ファイルが無いときだけ初期状態で始める。
 *
 * 読み込みが失敗したら throw して起動を止める（fail-closed）。壊れた JSON・スキーマ違反に
 * 加えて、不変量を破る v3 の状態と、不変量の前提（id の一意性・採番と既存 id の整合・
 * `startAmount > 0`）を破る v3 の状態も失敗になる。判定は `loadState` が行い、不変量 6 の
 * 拘束額は手数料込みなので、SessionStore と同じ手数料率とロガーを渡す。
 */
export async function loadOrInitDefault(
  initialJpy: number,
  opts: SessionStoreOptions = {},
): Promise<SessionStore> {
  const path = opts.path === undefined ? defaultStatePath("default") : opts.path;
  let state: PaperState;
  if (path) {
    // 不変量 6 は手数料込みの拘束額を見るので、SessionStore と同じ手数料率で検査する。
    const r = await loadState(path, { feeRate: opts.feeRate, logger: opts.logger });
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
