/**
 * 公式のペア一覧を写した表。
 *
 * 出典は bitbank 公式ドキュメントの
 * [`pairs.md`](https://github.com/bitbankinc/bitbank-api-docs/blob/master/pairs.md)。
 * 2026-09-17 時点の 62 行をそのまま写した。同日に `GET https://api.bitbank.cc/v1/spot/pairs`
 * （認証不要）を叩いた応答と**ペアの集合も並び順も一致**し、公式表の
 * "Order suspended flag (delisted)" 列に対応する API のフィールドが `stop_order` である
 * ことも確認している（`docs/fidelity.md` の「ペア」節）。
 *
 * **外部へは取りに行かない。** この表は静的で、モックは起動時も要求処理中も
 * ペア一覧のために通信しない。取りに行かないと分からないのは 1 件の観測でしか
 * 裏を取れていない値（`unit_amount` や手数料率）の方で、ペアの実在と発注停止の 2 つは
 * 公式ドキュメントに静的に載っているため、写すだけで足りる。
 *
 * **写したのはペア名と停止フラグだけで、公式表の base / quote 列は持たない。**
 * 公式表は `sky_jpy` の base を `sui` と書いており（2026-09-17 時点。誤記とみられる）、
 * 列をそのまま信じると名前と食い違う。base / quote が要るところは今までどおり
 * `pairAssets()` がペア名から導く。
 *
 * **一覧が古くなる方向の失敗は避けられない。** bitbank が新しいペアを足しても、この表は
 * 誰かが更新するまで古いままで、本物なら通る発注をモックが `40017` で断る。上場は
 * 上場廃止より頻繁なので、失敗はこの向きに倒れる。実 API に合わせたいなら
 * `/spot/pairs` を取得する（`docs/fidelity.md` の「ペア」節に論点として残してある）。
 */
export type PairSpec = {
  /** ペア名（`btc_jpy` など）。 */
  readonly pair: string;
  /**
   * 公式表の "Order suspended flag (delisted)" 列。`true` なら新規発注できない。
   *
   * `true` でも**照会はできる**。62 ペア中 18 ペアが `true` で、内訳は `_btc` の 15 ペア
   * 全部と `mkr_jpy` / `matic_jpy` / `rndr_jpy`。`_btc` が一覧に残っているのは、税計算などの
   * ために約定履歴を取れるようにするためである。
   *
   * **本モックはこのフラグをまだ発注の可否に使っていない。** 停止中のペアへ発注したとき
   * 実 API が何を返すかを実測していないためで、コードを推測で決めないための保留である
   * （`docs/fidelity.md` の「ペア」節）。表に持っておくのは、決まったときに実装が
   * この 1 か所で済むようにするため。
   */
  readonly orderSuspended: boolean;
};

/** 公式 `pairs.md` の 62 行（並び順も公式表のまま）。 */
export const OFFICIAL_PAIRS: readonly PairSpec[] = [
  { pair: "btc_jpy", orderSuspended: false },
  { pair: "xrp_jpy", orderSuspended: false },
  { pair: "xrp_btc", orderSuspended: true },
  { pair: "ltc_jpy", orderSuspended: false },
  { pair: "ltc_btc", orderSuspended: true },
  { pair: "eth_jpy", orderSuspended: false },
  { pair: "eth_btc", orderSuspended: true },
  { pair: "mona_jpy", orderSuspended: false },
  { pair: "mona_btc", orderSuspended: true },
  { pair: "bcc_jpy", orderSuspended: false },
  { pair: "bcc_btc", orderSuspended: true },
  { pair: "xlm_jpy", orderSuspended: false },
  { pair: "xlm_btc", orderSuspended: true },
  { pair: "qtum_jpy", orderSuspended: false },
  { pair: "qtum_btc", orderSuspended: true },
  { pair: "bat_jpy", orderSuspended: false },
  { pair: "bat_btc", orderSuspended: true },
  { pair: "omg_jpy", orderSuspended: false },
  { pair: "omg_btc", orderSuspended: true },
  { pair: "xym_jpy", orderSuspended: false },
  { pair: "xym_btc", orderSuspended: true },
  { pair: "link_jpy", orderSuspended: false },
  { pair: "link_btc", orderSuspended: true },
  { pair: "mkr_jpy", orderSuspended: true },
  { pair: "mkr_btc", orderSuspended: true },
  { pair: "boba_jpy", orderSuspended: false },
  { pair: "boba_btc", orderSuspended: true },
  { pair: "enj_jpy", orderSuspended: false },
  { pair: "enj_btc", orderSuspended: true },
  { pair: "matic_jpy", orderSuspended: true },
  { pair: "matic_btc", orderSuspended: true },
  { pair: "dot_jpy", orderSuspended: false },
  { pair: "doge_jpy", orderSuspended: false },
  { pair: "astr_jpy", orderSuspended: false },
  { pair: "ada_jpy", orderSuspended: false },
  { pair: "avax_jpy", orderSuspended: false },
  { pair: "axs_jpy", orderSuspended: false },
  { pair: "flr_jpy", orderSuspended: false },
  { pair: "sand_jpy", orderSuspended: false },
  { pair: "gala_jpy", orderSuspended: false },
  { pair: "ape_jpy", orderSuspended: false },
  { pair: "chz_jpy", orderSuspended: false },
  { pair: "oas_jpy", orderSuspended: false },
  { pair: "mana_jpy", orderSuspended: false },
  { pair: "grt_jpy", orderSuspended: false },
  { pair: "rndr_jpy", orderSuspended: true },
  { pair: "bnb_jpy", orderSuspended: false },
  { pair: "dai_jpy", orderSuspended: false },
  { pair: "op_jpy", orderSuspended: false },
  { pair: "arb_jpy", orderSuspended: false },
  { pair: "klay_jpy", orderSuspended: false },
  { pair: "imx_jpy", orderSuspended: false },
  { pair: "mask_jpy", orderSuspended: false },
  { pair: "pol_jpy", orderSuspended: false },
  { pair: "sol_jpy", orderSuspended: false },
  { pair: "cyber_jpy", orderSuspended: false },
  { pair: "render_jpy", orderSuspended: false },
  { pair: "trx_jpy", orderSuspended: false },
  { pair: "lpt_jpy", orderSuspended: false },
  { pair: "atom_jpy", orderSuspended: false },
  { pair: "sui_jpy", orderSuspended: false },
  { pair: "sky_jpy", orderSuspended: false },];

const KNOWN_PAIRS: ReadonlySet<string> = new Set(OFFICIAL_PAIRS.map((p) => p.pair));

/** 公式一覧にあるペアか。 */
export function isKnownPair(pair: string): boolean {
  return KNOWN_PAIRS.has(pair);
}
