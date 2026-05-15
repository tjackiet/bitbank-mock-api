import type { Candle } from "../engine/candles.ts";
import { defaultFetchCandles } from "../engine/candles.ts";
import { runTick } from "../engine/match.ts";
import { defaultStatePath, loadState, saveState } from "../engine/persist.ts";
import {
  DEFAULT_TAKER_FEE_RATE,
  nowIso,
  type PaperHistoryEntry,
  type PaperState,
} from "../engine/state.ts";
import type { FetchCandles, Logger } from "../engine/types.ts";
import { noopLogger } from "../engine/types.ts";

const LATEST_LOOKBACK_MS = 5 * 60_000;

export type SessionStoreOptions = {
  fetchCandles?: FetchCandles;
  path?: string | null;
  feeRate?: number;
  logger?: Logger;
};

export class SessionStore {
  private _state: PaperState;
  private readonly fetchCandles: FetchCandles;
  private readonly path: string | null;
  readonly feeRate: number;
  private readonly logger: Logger;
  private orderCounter = 0;

  constructor(state: PaperState, opts: SessionStoreOptions = {}) {
    this._state = state;
    this.fetchCandles = opts.fetchCandles ?? defaultFetchCandles();
    this.path = opts.path === undefined ? defaultStatePath("default") : opts.path;
    this.feeRate = opts.feeRate ?? DEFAULT_TAKER_FEE_RATE;
    this.logger = opts.logger ?? noopLogger;
  }

  state(): PaperState {
    return this._state;
  }

  replace(next: PaperState): void {
    this._state = next;
  }

  nextOrderId(): string {
    this.orderCounter = (this.orderCounter + 1) % 1000;
    return `${Date.now() * 1000 + this.orderCounter}`;
  }

  async tick(nowMs: number = Date.now()): Promise<Map<string, Candle[]>> {
    const result = new Map<string, Candle[]>();
    const pairs = new Set(this._state.openOrders.map((o) => o.pair));
    const lastMs = Date.parse(this._state.lastTickAt);
    for (const pair of pairs) {
      const r = await this.fetchCandles(pair, lastMs, nowMs);
      if (!r.success) {
        this.logger.warn(`tick: fetchCandles failed for ${pair}: ${r.error}`);
        result.set(pair, []);
        continue;
      }
      result.set(pair, r.data);
      const others = this._state.openOrders.filter((o) => o.pair !== pair);
      const subState: PaperState = {
        ...this._state,
        openOrders: this._state.openOrders.filter((o) => o.pair === pair),
      };
      const sr = runTick(subState, {
        candles: r.data,
        nowMs,
        feeRate: this.feeRate,
        logger: this.logger,
      });
      this._state = {
        ...sr.state,
        openOrders: [...sr.state.openOrders, ...others],
      };
    }
    const ts = new Date(nowMs).toISOString();
    this._state = { ...this._state, lastTickAt: ts, updatedAt: ts };
    return result;
  }

  async getLatestPrice(pair: string, nowMs: number = Date.now()): Promise<number | null> {
    const r = await this.fetchCandles(pair, nowMs - LATEST_LOOKBACK_MS, nowMs);
    if (!r.success || r.data.length === 0) return null;
    return r.data.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b)).close;
  }

  appendHistory(entry: PaperHistoryEntry): void {
    this._state = { ...this._state, history: [...this._state.history, entry] };
  }

  async persist(): Promise<void> {
    if (!this.path) return;
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
    version: 2,
    createdAt: now,
    updatedAt: now,
    initialJpy,
    balances: { jpy: initialJpy },
    history: [],
    lastTickAt: now,
    openOrders: [],
  };
}
