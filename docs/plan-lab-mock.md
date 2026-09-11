# bitbank-lab-mock 開発計画（Nyx 共同研究プラン A 対応）

作成日: 2026-09-11（同日、Nyx 提案書との突き合わせを反映して改訂）
対象: 「bitbank-lab-mock 研究用要件メモ」の R1〜R4 と 5〜7 節
前提: 本計画は現行コード（`main` @ `0859aab`、テスト 45 件・`tsc --noEmit` 通過を確認済み）、bitbank 公式 `bitbank-api-docs`（rest-api.md / private-stream.md / errors.md）、および Nyx Foundation の「共同研究 提案書 兼 技術仕様案 v1.0」「技術別紙 v1.0」（いずれも 2026-08-20 発行）を突き合わせて作成した。提案書と要件メモが食い違う箇所は要件メモを優先し、食い違いは 1.4 節に列挙した。

---

## 0. 結論（先に要点）

| 論点 | 結論 |
|---|---|
| R1 と R3 を一体で扱うか | **一体で扱う。** 注文レコード（`OrderRecord`）を単一の真実にする R3 の構造変更を先に入れ、その上に R1 の 2 エンドポイントを「レコードを整形して返すだけ」として実装する。R1 単体の小手先対応（`history` や取消済みリストから逆引き）は、`ordered_at` の誤り・`executed_amount` の欠落・取消済み注文の消失を引きずるため採らない |
| 着手順 | Phase 0（対応表の骨子・公式 doc 確認・CI 導入）→ Phase 1（R3 状態モデル）→ Phase 2（R1 照会 API）→ Phase 3（R2 control API）→ Phase 4（README 免責・対応表確定・v0.1.0 タグ）→ Phase 5（R4 private stream、11 月） |
| 期日の目安 | 提案書の立ち上げフェーズが終わる **10/23 までに v0.1.0（R1 + R2 + R3 の 3 値到達分）を Nyx に渡す**。週割りは 10/10 を狙って組み、2 週間の遅れを許容する。実装フェーズ最初の 1 週間（タスク 3.2）は現行モックでも成立する |
| 提案書との整合 | DCL のリコンサイルは `orders_info` を使うので R1 は一括照会が主。数量・価格はペアの桁数で固定小数に整形する（DCL は円・satoshi の整数で扱う）。経路 MCP → DCL → モックには bitbank-lab-mcp 側の接続先上書きが要る（本リポジトリ外の前提条件） |
| 既存テストへの影響 | 45 件中、書き換えが必要なのは約 20 件（engine/match 11 件のうち 8 件、engine/state 13 件のうち 5 件、routes 15 件のうち 7 件）。**削除するテストは無い。** アサーション対象を `state.openOrders` / `state.history` からビュー関数へ差し替えるのが主 |
| 対応表 | Phase 0 で `docs/fidelity.md` を作り、以後すべての PR で「対応表を更新したか」をチェック項目にする。Phase 4 で API 担当レビュー（60 分）向けに凍結 |

---

## 1. 現状の再確認（メモとの差分）

メモ 2 節の記述は概ね正確。コードを読んで確認した補足・訂正を挙げる。**★ は計画に影響するもの。**

### 1.1 メモの通りだった点

- `PaperState` は `balances` / `openOrders` / `history` の 3 つ。注文レコードは無い
- `applyFill()` は全量約定。`runTick()` は 1 分足の high/low 判定
- `formatOpenOrder` → `UNFILLED` 固定、`formatHistoryAsOrder` → `FULLY_FILLED` 固定で `ordered_at` に約定時刻、`formatCanceledOrder` → `CANCELED_UNFILLED` 固定
- `OrderStatus` 型は 5 値。`INACTIVE` / `REJECTED` は無い
- 注文 ID は `Date.now() * 1000 + counter`（`SessionStore.nextOrderId()`、**プロセス再起動でカウンタがリセットされる**）

### 1.2 メモに無かった点

- ★ **成行注文は `openOrders` を経由せず直接 `history` に入る**（`create-order.ts`）。注文 ID は採番されるので、R1 では成行も ID で引けなければならない（DCL は指値のみだが、モックの整合性として）
- ★ **すべてのルートが冒頭で `store.tick()` を呼び、テスト以外では bitbank public API に実際にアクセスする。** R2 で「価格を与えて tick を回す」を作っても、次の REST 呼び出しで実市場の足によって勝手に約定しうる。**R2 には「自動 tick を止めるモード」が必須**（3.3 節）
- ★ `trade_id` が `order_id` と同一値（`formatTrade`）。1 注文 1 約定の現状では衝突しないが、部分約定へ拡張すると破綻する。R3 で採番を分ける
- ★ **エラーコードの誤用がある。** 残高不足に `50008`（公式: Identity verification is not finished）を返しているが、公式の残高不足は `60001` Insufficient amount。`INVALID_AMOUNT: 30009` は公式では Missing asset、`INVALID_PRICE: 30013` は Missing side。DCL が拒否理由をコードで判別する可能性があるため、R1 と同時に是正し対応表に載せる
- `cancel_order` の応答に `canceled_at` が無い。公式では必須フィールド
- `user_cancelable` / `post_only` / `expire_at` を返していない。公式応答に存在するフィールド
- 取消対象が約定済み・取消済みの場合、現状は一律 `50009`（Order not found）。公式には `50026`（already canceled）/ `50027`（already executed）がある
- 認証ヘッダのチェックは無い（design.md 上 P1）。DCL 側が HMAC を付けて送っても通るので、プラン A ではこのままでよい
- 永続化は既定で `~/.bitbank-mock/sessions/default/state.json`。`version: 2` の Zod スキーマと v1→v2 マイグレーションがあるので、R3 は **v3 + マイグレーション**として実装する
- README は旧ロードマップ（ダッシュボード・WS public プロキシ・サンプル bot）を掲げており、メモ 4 節の非目標と矛盾する。移管時に書き換える（Phase 4）

### 1.3 公式ドキュメントの確認結果（R1 に直結）

rest-api.md（2026-09-11 取得）より。

| 用途 | メソッド・パス | パラメータ | 備考 |
|---|---|---|---|
| 単一注文の照会 | `GET /v1/user/spot/order` | query: `pair`（必須）, `order_id`（必須） | 発注 `POST /v1/user/spot/order` と同パス・別メソッド。メモの推測通り |
| 複数注文の一括照会 | `POST /v1/user/spot/orders_info` | body: `pair`, `order_ids: number[]` | 応答は `{ orders: [...] }`。存在しない ID は**エラーにならず単に含まれない**（3 か月以上前の注文に関する Caveat から。存在しない ID そのものの記述は無いので推測として対応表に記録） |
| 単一照会で見つからない場合 | 同上 | | Caveat に「3 か月以上前の注文は `50009`」とある。存在しない ID も `50009` と推測（対応表に記録） |

照会応答のフィールド（公式）: `order_id`, `pair`, `side`, `position_side?`, `type`, `start_amount`, `remaining_amount`, `executed_amount`, `price?`, `post_only?`, `user_cancelable`, `average_price`, `ordered_at`, `expire_at`, `triggered_at?`, `trigger_price?`, `status`。取消応答にはさらに `canceled_at`。

status の enum は照会で 7 値。**発注・取消の応答では `REJECTED` を除く 6 値**と書かれている（照会でのみ `REJECTED` が現れる）。

そのほか R1 に関係する公式仕様:

- `active_orders` は `count` / `from_id` / `end_id` / `since` / `end` を受ける（現状 `pair` のみ）
- `trade_history` は `order_id` / `since` / `end` / `order(asc|desc)` を受ける（現状 `pair` / `count` のみ）。DCL が注文単位で約定を突き合わせる際に `order_id` 絞り込みを使う可能性が高い
- レート制限は QUERY 10 回/秒、UPDATE 6 回/秒、超過時 HTTP 429（プラン A では実装しないが対応表に載せる）

private-stream.md より（R4 に直結）:

- 配信メッセージは `{ "message": { "method": "...", "params": [...] } }`
- 注文系は `spot_order_new`（新規）/ `spot_order`（更新）で、**どちらも注文の全フィールドを含むスナップショット**。約定は `spot_trade`、残高は `asset_update`
- シーケンス番号・順序保証の記述は無い（メモ通り）
- 接続には `GET /v1/user/subscribe` で `pubnub_channel` / `pubnub_token` を得る。トークン TTL 12 時間

### 1.4 Nyx 提案書（本編 v1.0・技術別紙 v1.0）との突き合わせ

提案書のうち、このモックの設計に直接効く記述と、その反映先を挙げる。

| 提案書の記述 | 出典 | 本計画への反映 |
|---|---|---|
| DCL の `Reconcile(ids)` は **REST の `orders_info` を引く**。`OrderSnapshot(id, status, executed, remaining, avg_price)` が「状態を決める唯一のイベント」 | 本編 6.3 | R1 は一括照会 `POST /v1/user/spot/orders_info` を主、単一照会 `GET /v1/user/spot/order` を従とする。`average_price` は `executedNotional / executedAmount` で正確に出す（3.2） |
| `orders_info` で存在しない ID が「エラーも返さず含まれない」と、DCL 側ではその注文の snapshot が永遠に届かず stale 判定に落ちる | 本編 6.3、別紙 5.6 の fail-closed 規則 | 公式 doc 通りの挙動（含まれない）を採るが、対応表に「推測」として明記し、Nyx にこの挙動を前提に DCL を設計してもらう（3.2） |
| 単調性・終端状態の優先・「異なる終端が複数届いたら矛盾」の 5 規則 | 別紙 5.6 | 3.1 の不変量 4（終端状態は不変）がこの規則の前提になる。不変量テストで必ず検証する |
| committed を動かすのは `OrderSnapshot` だけ。`spot_trade` は価格取得にのみ使う | 本編 6.3 | R4 は `spot_order` のスナップショット配信が本体で、`spot_trade` は補助。R4 の優先度が低いままでよい根拠 |
| プラン A では**部分約定を状態機械・実装・証明に含める**。実験環境での部分約定の注入だけが範囲外 | 本編 12.1 | R3 の 7 値モデルと `fillOrder(amount < remaining)` の受け口は必須。`/_control/orders/:id/fill` の `amount` 指定はプラン A から受け付けてよい（3.3） |
| プラン A の障害注入（重複・順序入替）は **D2 のテストコード側**で扱う | 本編 8.3、10 章の表 | モックの R4 に障害注入を入れる必要はプラン A では無い。`DeliveryPolicy` の差し込み口だけ残す（3.4） |
| 金額と数量は**整数の最小単位（円、satoshi）**で扱う。Cedar の decimal が 4 桁のため | 本編 8.1-5、別紙 5.3 | モックの数値は JS の倍精度なので、文字列化で `0.30000000000000004` のような値が出うる。**応答の `amount` / `price` はペアの桁数（btc_jpy なら数量 4 桁・価格整数）で固定小数に整形する**。桁数は公式 `pairs.md` / `GET /spot/pairs` で確認し対応表に載せる（3.2） |
| 実験環境は `bitbankinc/mock-bitbankcc` を拡張する前提。拡張が困難なら Nyx が 8 人日でスタブを作る（R5） | 本編 10 章、13.3 R5、確認事項 14 | 確認事項 14 への回答は「mock-bitbankcc ではなく本リポジトリを使う」になる。README の棲み分け記述（7 節）を Nyx への回答文としても使う |
| D2 は「bitbank-lab-mcp と bitbank 取引 API の間」に接続する。bitbank 側の分担は「接続点の提供」 | 本編 5.1、11.1 | 経路は MCP → DCL → モック。**bitbank-lab-mcp は `src/private/client.ts` に `api.bitbank.cc` を直書きしており、接続先を差し替えられない**（2026-08-24 の main で確認）。MCP 側に base URL の上書き手段を足す作業が「接続点の提供」にあたり、本リポジトリ外の前提条件になる（8 節） |
| 実装の最初の 1 週間（10/28〜）で「確認トークンに累計が無い」ことを実験環境上で再現する（タスク 3.2） | 本編 8.1 末尾 | 分割回避シナリオ（9.9 万円 × 6 本）は約定を必要とせず、発注 6 本が通ればよい。**現行のモックでも再現可能**。R2 が無くても最初の 1 週間は止まらない |
| 論点 6: 委譲元が発行する冪等キーを必須とする。bitbank API にはクライアント注文 ID の口が無い | 本編 4 章既定値、8.1-2 | 発注応答が届かなかった場合、DCL は `active_orders` から自分の注文を探すしかない。`active_orders` の `since` / `from_id` 対応を R1 の範囲に含める（3.2） |
| 確認事項 1〜6（訂正なし・PubNub 順序非保証・INACTIVE の意味・レート制限・`CANCELED_PARTIALLY_FILLED` の `executed_amount`・成行の価格上限なし） | 本編 14.1 | **対応表の行として最初から載せる。** モックが公式 doc からどう決めたかを書けば、そのまま bitbank 側の回答の下書きになる（5 節） |
| 手数料は損失に含める。プラン A は `loss_limit` 未設定で損失系の不変量は自明に成立 | 本編 4 章既定値、6.3 | プラン A の Exposure（累積約定代金）に手数料は乗らない。指値をテイカー 0.12% のまま維持しても DCL の判定に影響しない。9 節 3 の推奨を維持 |
| DCL の `reserved` は `price × size`（手数料なし）。モックの `locked_amount` は `price × amount × (1 + fee)` | 本編 6.3、`state.ts` `computeLocked` | 委譲枠と口座残高が近いとき、DCL が許可した注文をモックが `60001`（残高不足）で拒否しうる。本物の bitbank が拘束額に手数料を含めるかは公式 doc に無い。対応表の「要確認」行にする |

**提案書内の版ズレ（要件メモを優先した根拠）**

- 本編の表紙は v1.0 だが、技術別紙は「本編: 共同研究提案書 v1.6」を参照している
- 別紙が参照する本編の節番号が一致しない。別紙は「監査ログ 6.6」「完全媒介は確認事項 3」「2.2 の 280 回の Simulation」を指すが、手元の本編では監査ログは 6.5、完全媒介は確認事項 9、Simulation は確認事項 18 にある
- 本編は実験環境を mock-bitbankcc としているが、要件メモは本リポジトリとしている

いずれも本計画の技術判断には影響しない。「v1.6」は誤記の可能性が高いため追わず、対応表の「出典」列は手元の本編 v1.0 の節番号で書く。Nyx から改版が届いたときに直す。

---

## 2. 全体の進め方と順序

### 2.1 Phase 0 に含める基盤作業: GitHub Actions

現状 `.github/` が無く、テストと型検査はローカルの手動実行に頼っている。Phase 1 で既存テストの約半分を書き換えるため、その前に PR ごとの自動実行を入れる。姉妹リポジトリ bitbank-lab-cli の `.github/workflows/ci.yml` と `security.yml` をほぼそのまま流用する。

| ワークフロー | 内容 | 判断 |
|---|---|---|
| `ci.yml` | PR と main への push で `npm ci` → `tsc --noEmit` → `vitest run` | 必須。Phase 1 より前に入れる |
| `security.yml`（`npm audit --audit-level=high`） | 依存の脆弱性を high 以上でブロック。週 1 の定期実行付き | 入れる。依存が 3 つしか無いので落ちる要素が少なく、コストも低い |
| `security.yml`（gitleaks） | git 全履歴の秘密情報スキャン。バージョンと SHA256 を固定 | 入れる。このモックは API キーを扱わないが、移管先の bitbankinc では CLI と MCP が既にやっており、揃えておく |
| lint（biome） | 整形と静的解析 | 任意。入れるなら Phase 0 で `biome.json` を足し、`ci.yml` に `biome check src/ tests/` を加える |

CD（自動デプロイ・npm 公開・GitHub Release）は作らない。Nyx への引き渡しは git のタグで足りる。`.nvmrc` が無いので `ci.yml` の `node-version-file` は `package.json` の `engines`（Node 20 以上）に合わせて `node-version: 20` を直書きするか、`.nvmrc` を追加する。

```
Phase 0  対応表の骨子 / 公式 doc との差分洗い出し / CI    9/15 週  （1〜2 日）
Phase 1  R3: 注文レコード中心の状態モデル（v3）         9/15〜9/26
Phase 2  R1: GET order / POST orders_info + 周辺整合   9/22〜10/3   （Phase 1 と一部並行）
Phase 3  R2: /_control/ 名前空間                       9/29〜10/8
Phase 4  README 免責 / 対応表凍結 / v0.1.0 タグ         10/6〜10/10
   ── 10/13 週: バッファ、Nyx との結合確認 ──
Phase 5  R4: private stream                            11 月
移管     repository transfer / リネーム                 Phase 4 完了後、bitbankinc 側の準備が整い次第
```

Phase 1 を先にする理由は 0 節の通り。Phase 1 の途中で期日リスクが顕在化した場合の退避策は 8 節。

---

## 3. 設計

### 3.1 R3: 状態モデル（PaperState v3）

メモ 3 節 R3 の提案をそのまま採用し、細部を決める。

```ts
// src/engine/state.ts（v3）
type OrderStatus =
  | "INACTIVE" | "UNFILLED" | "PARTIALLY_FILLED" | "FULLY_FILLED"
  | "CANCELED_UNFILLED" | "CANCELED_PARTIALLY_FILLED" | "REJECTED";

type OrderRecord = {
  id: string;                  // 数値文字列。応答時に number 化（現行 toIdOut を踏襲）
  pair: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price: number | null;        // market は null
  startAmount: number;
  executedAmount: number;      // 不変量: 0 <= executed <= start
  executedNotional: number;    // Σ(price × amount)。average_price = notional / executed
  status: OrderStatus;
  orderedAt: string;           // 発注時刻（ordered_at の真の値）
  canceledAt: string | null;
  updatedAt: string;
};

type TradeRecord = {           // 旧 PaperHistoryEntry
  tradeId: string;
  orderId: string;
  pair; side; type; amount; price; feeQuote; makerTaker; executedAt;
};

type PaperState = {
  version: 3;
  createdAt; updatedAt; initialJpy; lastTickAt;
  balances: Record<string, number>;
  orders: OrderRecord[];       // 単一の真実。生成順
  trades: TradeRecord[];       // 旧 history。orderId で orders に紐づく
  nextOrderSeq: number;        // 採番カウンタ（永続化して再起動で戻らない）
  nextTradeSeq: number;
};
```

**ビュー関数**（`openOrders` の代替）:

```ts
export const isActive = (o) => o.status === "UNFILLED" || o.status === "PARTIALLY_FILLED";
export const activeOrders = (s) => s.orders.filter(isActive);
export const remainingOf = (o) => o.startAmount - o.executedAmount;
```

`computeLocked()` / `availableOf()` は `activeOrders(s)` と `remainingOf(o)` で計算するように変えるだけで、発想は現状のまま活かす。

**状態遷移を 1 か所に集める**（`src/engine/transitions.ts`、新設）:

```ts
placeOrder(state, input, now)             → { state, order }       // UNFILLED（market は即 fill まで進める）
fillOrder(state, orderId, price, amount, at) → { state, order, trade }
   // amount < remaining なら PARTIALLY_FILLED、== remaining なら FULLY_FILLED
   // プラン A では呼び出し側が常に amount = remaining を渡す（部分約定は起こさない）
cancelOrder(state, orderId, at)           → { state, order }
   // UNFILLED → CANCELED_UNFILLED、PARTIALLY_FILLED → CANCELED_PARTIALLY_FILLED
   // 終端状態なら Result.error（呼び出し側が 50026 / 50027 に変換）
rejectOrder(state, orderId, at)           → REJECTED（プラン A では到達させない。関数だけ用意）
```

`applyFill()` / `runTick()` は内部で `fillOrder()` を呼ぶ薄いラッパにする。`runTick()` の 1 分足判定ロジック自体は変えない。

**不変量**（テストで検証し、そのまま Nyx の仕様書 D1 に渡せる形で `docs/fidelity.md` にも書く）:

1. `0 <= executedAmount <= startAmount`
2. `status ∈ {INACTIVE, UNFILLED}` ⇔ `executedAmount == 0` かつ非終端（`INACTIVE` はプラン A では到達しないが、7 値モデルの不変量としてはここに含める）
3. `status ∈ {FULLY_FILLED}` ⇔ `executedAmount == startAmount`
4. 終端状態（`FULLY_FILLED` / `CANCELED_*` / `REJECTED`）に達したレコードは以後いかなる遷移でも変化しない
5. `trades` の `orderId` ごとの `amount` 合計 == その注文の `executedAmount`
6. 資産ごとの `locked` == アクティブ注文の未約定分から計算した値（現行 `computeLocked` と同義）

**永続化**: `PaperStateSchemaV3` を追加し、`persist.ts` の `migrateToLatest` に v2→v3 を足す。v2 の `openOrders` は `UNFILLED` のレコードに、`history` は `FULLY_FILLED` のレコード + `TradeRecord` に変換する（v2 には発注時刻が無いので `orderedAt = filledAt` とし、対応表に「移行データは `ordered_at` が不正確」と記録）。

移行時の ID 衝突を防ぐ規則:

- 移行した `TradeRecord` の `tradeId` は、`history` の並び順に `1, 2, ...` を振り直す（v2 の `id` は注文 ID なので trade ID には使わない）。`nextTradeSeq` はその最大値 + 1
- `nextOrderSeq` は、移行した注文 ID のうち数値として解釈できるものの最大値 + 1 とする。旧形式の巨大な ID（`Date.now() * 1000 + counter`）が残る場合はそこから続きを振るので、単調増加は保たれる（桁が大きいままになる点は対応表に記録）
- `nextOrderSeq` / `nextTradeSeq` は状態に永続化し、再起動後もそこから続ける
- テスト: v2 ファイルを読み込んで再起動し、以後の発注・約定の ID が既存レコードと衝突せず単調増加することを `tests/engine/state.test.ts` で確認する

**注文 ID 採番（決定済み、2026-09-11）**: `Date.now() * 1000 + counter` をやめ、状態に持つ連番（`nextOrderSeq`、初期値 `1`）にする。理由は (a) 再起動で重複しない、(b) シナリオスクリプトで ID を予測でき、再現性が上がる、(c) 本物も単調増加の整数である点は同じ。桁数が本物と異なる点は対応表へ。

### 3.2 R1: 注文照会エンドポイント

| 追加 | 内容 |
|---|---|
| `POST /v1/user/spot/orders_info`（主） | body `pair`, `order_ids[]`。見つかったものだけ `{ orders: [...] }` で返す。0 件でも `success: 1`。DCL の `Reconcile(ids)` が使う経路（1.4 節） |
| `GET /v1/user/spot/order`（従） | query `pair`, `order_id`。`orders` から検索し `formatOrder()` で整形。見つからない、または `pair` 不一致なら `50009` |

同時に行う整合作業（すべて `OrderRecord` があれば自然にできるもの）:

- `format.ts` を `formatOrder(o: OrderRecord)` 1 本に統合。`status` / `executed_amount` / `remaining_amount` / `average_price` / `ordered_at` をレコードから出す。`canceled_at`（取消時のみ）、`user_cancelable`（アクティブなら true）、`post_only: false`、`expire_at: null` を追加
- **数量・価格の文字列化をペアの桁数で固定小数にする**（例: btc_jpy の数量は 4 桁、価格は整数）。DCL は円と satoshi の整数で扱うため、倍精度の丸め誤差が文字列に漏れると解析に失敗する（1.4 節）。桁数の出典は公式 `pairs.md` / `GET /spot/pairs` とし、プラン A では btc_jpy を定数で持つ
- `active_orders` を `activeOrders(state)` のビューに切り替え（`PARTIALLY_FILLED` も含む）。`count` / `since` / `end` / `from_id` / `end_id` を受け付ける。発注応答を取りこぼした DCL が自分の注文を探す経路になるため、`since` / `from_id` は実際に絞り込みを効かせる（1.4 節）
- `trade_history` に `order_id` / `since` / `end` / `order` を追加
- `cancel_order` / `cancel_orders` の終端状態への応答を `50026` / `50027` に変更
- エラーコードの是正: 残高不足 `60001`、amount 欠落 `30001`、price 欠落 `30012`、side 欠落 `30013`、type 欠落 `30015`、order_id 欠落 `30006`

**R1 の受入条件と確認方法**

| 受入条件 | テスト |
|---|---|
| 生成したすべての注文が ID で引ける | 指値 → 約定 / 指値 → 取消 / 成行 の 3 経路で `GET order` が `success: 1` |
| `status` 等 5 フィールドが正しい | 各経路で `status`, `executed_amount`, `remaining_amount`, `average_price`, `ordered_at` を検証。特に `ordered_at` が発注時刻で、約定後も変わらないこと |
| 存在しない ID の挙動 | `GET order` → `50009`、`orders_info` → 含まれず `success: 1` |
| `pair` 不一致 | `GET order` → `50009` |
| 数値の整形 | 発注量 `0.1 + 0.2` 相当の演算を経ても `executed_amount` / `remaining_amount` がペアの桁数に収まった文字列であること |
| DCL のリコンサイル模擬 | 発注 → 約定 → `orders_info` を 2 回引いて同一スナップショットが返ること。プラン A の全量約定では `executed_amount × average_price` が約定代金と厳密に一致すること。部分約定を含む場合は下記の丸め規則の許容差内であること |

`average_price` の丸め規則: 内部では `executedNotional`（倍精度）を真値として保持し、`average_price = executedNotional / executedAmount` をペアの価格桁数（btc_jpy なら整数）に四捨五入して文字列化する。複数回の約定で平均が価格単位に乗らない場合（例: 100 と 101 で 0.5 ずつ約定 → 100.5）は丸めが入るため、`executed_amount × average_price` と約定代金の差は `executed_amount × 価格単位 × 0.5` 以下を許容する。DCL が `committed` をこの積で再計算する際に同じ誤差が乗ることは対応表に記録し、Nyx に伝える。内部演算を円・satoshi の整数に切り替えるかはプラン B（部分約定を実際に起こす段階）で判断する

### 3.3 R2: 約定を意図的に起こす仕組み（`/_control/`）

**有効化**: 環境変数 `BITBANK_MOCK_CONTROL=1` のときのみルートを登録する（既定は無効。無効時は 404）。

**アクセス境界**: 現状サーバは `0.0.0.0` で listen しているため、control を有効にすると同一ネットワークの誰でも状態を読み書きできる。次の 2 段で守る。

- control 有効時は listen ホストの既定を `127.0.0.1` にする（`BITBANK_MOCK_HOST` で明示した場合のみ他のアドレスに bind できる）
- `/_control/` の各ルートは、接続元がループバックでない場合は `X-Control-Token` ヘッダが `BITBANK_MOCK_CONTROL_TOKEN` と一致しない限り 403 で拒否する。トークン未設定なら非ループバックからは常に 403
- テスト: ループバックからの成功、非ループバック + トークン無しの 403、非ループバック + 正しいトークンの成功を `tests/routes/control.test.ts` に含める（Fastify の `inject` で `remoteAddress` を差し替える）

**自動 tick の停止**: `BITBANK_MOCK_FILL_MODE=market | manual`。`manual` では `store.tick()` が実市場の足を取りに行かず、`/_control/` からの操作でのみ状態が動く。**既定は control の有効・無効に連動させる（決定済み、2026-09-11）**: `BITBANK_MOCK_CONTROL` 未設定なら `market`（現行挙動）、設定時は `manual`。control を使いながら市場連動で試したい場合だけ `FILL_MODE=market` を明示する。設定忘れでシナリオの再現性が壊れないようにするため。

**エンドポイント**（すべて JSON、bitbank 封筒ではなく素の JSON で返す。bitbank API と誤解されないため）:

| メソッド | パス | 入力 | 動作 |
|---|---|---|---|
| POST | `/_control/orders/:order_id/fill` | `{ price?, amount? }` | 指定注文を約定させる。`price` 省略時は指値価格、`amount` 省略時は残量全部。`amount < remaining` なら `PARTIALLY_FILLED`（プラン B 用。プラン A では受け付けるが、README では「未検証」と明記）。入力検証は下記 |
| POST | `/_control/tick` | `{ pair, price }` または `{ pair, candle: { open, high, low, close, timestamp? } }` | 与えた価格を 1 本の足として `runTick()` を回す。`price` だけなら `high = low = price`。複数注文をまとめて動かす用 |
| POST | `/_control/reset` | `{ initialJpy?, balances? }` | 状態を初期化。シナリオ冒頭で使う |
| GET | `/_control/state` | | `PaperState` をそのまま返す（デバッグ用） |

`fill` は 3.1 の `fillOrder()` を直接呼ぶ。`tick` は `runTick()` に人工の足を渡す。どちらも既存の遷移関数を通るので、REST 経路と control 経路で状態の整合性が崩れない。

`fill` の入力検証（不変量 1 を control 経路から壊させないため）:

| 条件 | 応答 |
|---|---|
| 注文が存在しない | 404 `{ error: "ORDER_NOT_FOUND" }` |
| 注文が終端状態 | 409 `{ error: "ORDER_NOT_ACTIVE", status }` |
| `amount` が有限の正数でない、または `amount > remaining` | 400 `{ error: "INVALID_AMOUNT", remaining }` |
| `price` が有限の正数でない | 400 `{ error: "INVALID_PRICE" }` |

検証は `fillOrder()` を呼ぶ前に行い、拒否時は注文・残高・約定記録のいずれも変更しない。`fillOrder()` 自身も同じ条件で `Result.error` を返す二重防御にする（不変量テストの対象）。`tick` の `candle` も `low <= high` と正数を検証する。

**R2 の受入条件と確認方法**

- `tests/routes/control.test.ts`: `BITBANK_MOCK_CONTROL` 未設定で 404、設定時に各エンドポイントが動く
- `tests/scenarios/plan-a.test.ts`（新設）: 「発注 → `GET order` で UNFILLED → `/_control/orders/:id/fill` → `GET order` で FULLY_FILLED、`assets` の locked が減り onhand が変わる」を `fetchCandles` スタブ無しで通す。これが「実市場に依存せずシナリオをスクリプトで再現できる」の直接の証拠
- `examples/scenario-plan-a.sh`（curl 数行）: Nyx への引き渡し時のデモ手順。テストと同じ流れ

### 3.4 R4: private stream（11 月）

設計だけ先に決めておく。

- **トランスポート（決定済み、2026-09-11）**: PubNub を模倣せず、素の WebSocket（`@fastify/websocket`）を `ws://host/_stream/private` で提供する。`GET /v1/user/subscribe` は公式通りの形で `pubnub_channel` / `pubnub_token` を返し、値はダミー。README に「PubNub SDK ではなく WebSocket で受ける」と明記する。理由: PubNub のプロトコル互換を作る労力に対して、DCL 側で必要なのはメッセージ本体の互換だけ
- **メッセージ**: 公式と同じ `{ message: { method, params } }`。`params` は公式通り配列。イベントごとに整形関数を分ける
  - `spot_order_new`（発注時）/ `spot_order`（更新時）: `params: [formatOrder(order)]`。注文のスナップショット
  - `spot_trade`: `params: [formatTrade(trade)]`。REST の `trade_history` と同じ形
  - `asset_update`: `params: [formatAssetUpdate(asset)]`。変化した資産だけを載せる。**公式はこのメッセージだけキーが camelCase**（`freeAmount` / `lockedAmount` / `onhandAmount` / `amountPrecision` / `withdrawingAmount`）なので、REST の `formatAssets` とは別の整形関数にする
- **発火点**: 3.1 の遷移関数の戻り値を `{ order, trade?, touchedAssets: string[] }` に広げ、`SessionStore` が `order` / `trade` / `assets` の 3 種のイベントを emit する。REST 経路も control 経路も同じ遷移関数を通るため、発火漏れが無い
- **障害注入の余地**: emit と WebSocket 送信の間に `DeliveryPolicy` インタフェース（`deliver(events) => events`）を 1 つ挟む。プラン A では恒等写像。プラン B で重複・順序入替・欠落を差し込む
- **テスト**: `ws` クライアントで接続し、発注 → `/_control/` で約定 → 取消の流れで `spot_order_new` / `spot_order`（FULLY_FILLED と CANCELED_UNFILLED）/ `spot_trade` / `asset_update`（camelCase キー）の 4 種すべての形を検証する

---

## 4. 既存テスト（45 件）への影響と移行手順

### 4.1 影響の内訳

| ファイル | 件数 | 影響 | 内容 |
|---|---|---|---|
| `tests/engine/candles.test.ts` | 6 | なし | |
| `tests/routes/envelope.test.ts` | 2 | なし | |
| `tests/engine/match.test.ts` | 11 | **8 件書き換え** | `applyFill` の引数（`OpenOrder` → `orderId`）、`r.state.openOrders` / `r.state.history` のアサーションを `activeOrders(state)` / `state.trades` へ |
| `tests/engine/state.test.ts` | 13 | **5 件書き換え** | fresh state の形（v3）、`computeLocked` の入力（`orders`）、persist の round trip、v1→v2 移行テストに v2→v3 を追加 |
| `tests/routes/create-order.test.ts` | 5 | 2 件 | `store.state().openOrders` / `history` の参照 |
| `tests/routes/cancel-order.test.ts` | 3 | 3 件 | 同上 + `buildOrder` の形 |
| `tests/routes/active-orders.test.ts` | 2 | 1 件 | `buildState({ openOrders })` → `orders` |
| `tests/routes/trade-history.test.ts` | 2 | 1 件 | `history` → `trades` |
| `tests/routes/assets.test.ts` | 1 | 0〜1 件 | `buildState({ openOrders })` を使っていれば |

**削除するテストは無い。** 期待値（金額・件数・ステータス）はすべてそのまま成立する。

### 4.2 移行手順（Phase 1 を 3 コミットに分ける）

1. **ヘルパ先行**: `tests/engine/helpers.ts` の `buildState` / `buildOrder` を v3 の形にし、`buildOrder` は `OrderRecord`（`status: "UNFILLED"`, `executedAmount: 0`）を返すようにする。ここで一度全テストを壊す
2. **モデル + 遷移関数**: `state.ts` v3、`transitions.ts`、`persist.ts` の v2→v3。`match.ts` をラッパ化。engine テスト 30 件を通す
3. **ルート追随**: `create-order` / `cancel-order` / `active-orders` / `trade-history` / `format.ts` をレコード経由に。routes テスト 15 件を通す

各コミットで `npm test` と `npm run typecheck` を通す。1 の直後だけ赤でよい（同一 PR 内）。

### 4.3 新規テスト（要件ごと）

| 要件 | ファイル | 主な項目 |
|---|---|---|
| R3 | `tests/engine/transitions.test.ts` | 各遷移の前後状態、終端状態からの遷移拒否、部分約定時の `PARTIALLY_FILLED` と `average_price`、3.1 の不変量 1〜6 |
| R3 | `tests/engine/invariants.test.ts` | 発注・約定・取消をランダム順で数百回適用し、各ステップで不変量 1〜6 を検証（`fast-check` 導入を推奨。Lean 側の証明対象と同じ性質をテスト側でも押さえる） |
| R3 | `tests/engine/state.test.ts` | v2→v3 移行: `openOrders` → `UNFILLED`、`history` → `FULLY_FILLED` + `trades` |
| R1 | `tests/routes/order-info.test.ts` | 3.2 の表 |
| R1 | 既存 routes テストへ追加 | `cancel_order` の `50026` / `50027`、`canceled_at`、`ordered_at` が発注時刻、エラーコード是正 |
| R2 | `tests/routes/control.test.ts` / `tests/scenarios/plan-a.test.ts` | 3.3 節 |
| R4 | `tests/stream/private.test.ts` | 3.4 節 |

---

## 5. 対応表（`docs/fidelity.md`）の書き起こしタイミング

- **Phase 0（着手初日）に骨子を作る。** 列は「項目 / モックの挙動 / 根拠（公式 doc の節・引用） / 本物との差異 / 推測かどうか / 影響（DCL 仕様・証明への含意）」。メモ 5 節の 7 行に加え、1.2〜1.3 節で見つかった以下をシードとして入れる
  - 存在しない `order_id` への `GET order` の応答（`50009` と推測。doc は 3 か月以上前の注文についてのみ明記）
  - `orders_info` で存在しない ID を含まない挙動（推測）
  - エラーコード誤用の是正（`50008` → `60001` など）と、それでも網羅していないコード
  - 取消済み／約定済み注文への取消応答（`50026` / `50027`）
  - `trade_id` の採番、注文 ID の桁数
  - `maker_taker` が常に `maker`（指値）なのに手数料はテイカー 0.12% で計算している不整合（bitbank の手数料は通貨ペアごとにメイカー・テイカーで異なる。要確認）
  - `expire_at: null` / `post_only: false` / `user_cancelable` 固定値
  - v2→v3 移行データの `ordered_at` が約定時刻である点
  - `/_control/` は bitbank に存在しない（当然だが、DCL の仕様に control の存在が漏れないよう明記）
  - private stream を PubNub でなく WebSocket で提供する点（R4）
  - 拘束額（`locked_amount`）に手数料を含めている点。DCL の `reserved` は手数料を含まない（1.4 節。要確認）
  - 数量・価格の桁数（btc_jpy の数量 4 桁・価格整数）の出典
  - 提案書 14.1 の確認事項 1〜6 に対応する行。注文訂正 API が無いこと、PubNub の順序非保証、`INACTIVE` は逆指値のトリガー待ちでモックでは到達しないこと、レート制限をモックが持たないこと、`CANCELED_PARTIALLY_FILLED` で `executed_amount` が残ること、成行に価格上限指定が無いこと。**この 6 行はそのまま bitbank 側から Nyx への回答の下書きになる**
- **各 PR で更新する。** PR テンプレート（`.github/pull_request_template.md`、新設）に「公式 doc に無い挙動を推測で決めた場合、`docs/fidelity.md` に追記したか」のチェックボックスを置く
- **Phase 4（10/6 週）で凍結し、API 担当の 60 分レビューにかける。** レビュー結果は同ファイルに「確認済み／要修正」列として反映。Nyx の前提条件書には Phase 4 時点の版を渡す

---

## 6. スケジュール（目安）

今日 2026-09-11（木）。期日は厳密ではないので、以下は「何をどの順で終えるか」の目安として置く。提案書側の節目と合わせると、押さえるべき点は 2 つだけになる。

- **10/23（立ち上げフェーズの終わり）までに v0.1.0（R1 + R2 + R3 の 3 値到達分）を Nyx に渡す。** 提案書 12.2 では立ち上げ 10/01〜10/23 に実験環境の準備（bitbank 主担当）が含まれる
- **10/28 からの実装フェーズ最初の 1 週間（タスク 3.2）は現行のモックでも成立する**（分割回避シナリオは約定を要しない。1.4 節）。R2 が遅れてもここは止まらない

以下は 10/10 に v0.1.0 を切る前提の週割り。2 週間遅れても 10/23 に間に合う。

| 週 | 作業 | 完了条件 |
|---|---|---|
| 9/15〜9/19 | Phase 0: `docs/fidelity.md` 骨子、PR テンプレート、GitHub Actions（CI / Security Audit）。Phase 1 開始: ヘルパ・状態モデル v3・遷移関数・不変量テスト | engine テスト緑 |
| 9/22〜9/26 | Phase 1 完了: ルート追随、v2→v3 移行。Phase 2 開始: `GET order` / `orders_info` | 45 件 + 新規が緑。`GET order` で約定済み・取消済みが引ける |
| 9/29〜10/3 | Phase 2 完了: エラーコード是正、`canceled_at`、`active_orders` / `trade_history` パラメータ。Phase 3 開始: `/_control/` と `FILL_MODE=manual` | シナリオテスト `plan-a.test.ts` 緑 |
| 10/6〜10/10 | Phase 3 完了、README 免責・棲み分け、対応表凍結、**v0.1.0 タグ**、Nyx へ引き渡し（`examples/scenario-plan-a.sh` 付き） | Nyx が curl だけで「発注 → 約定 → 残枠減」を再現できる |
| 10/13〜10/17 | バッファ。Nyx 側の結合で出た指摘の反映。API 担当レビュー | |
| 10/20〜 | R4 設計レビュー、移管準備 | |
| 11 月 | Phase 5: R4 private stream | |

**工数感**: Phase 1 が最大で 4〜5 人日、Phase 2 が 2〜3 人日、Phase 3 が 2 人日、Phase 4 が 1〜2 人日。1 人で 10 人日前後、4 週間に対して余裕はあるが、Phase 1 の設計判断（3.1 節）を最初の 2 日で確定させることが鍵。

---

## 7. 移管に伴う作業（Phase 4 で準備、transfer は bitbankinc 側の準備後）

- `package.json` の `name` / `repository` / `description` を `bitbank-lab-mock` に。`bitbank-mock-api` の旧名は README に 1 行残す
- README を全面書き換え。構成: 何であるか（注文の状態を持つ挙動確認用モック）／**免責**（公開ドキュメント準拠の近似であり bitbank 公式のテスト環境ではない、動作保証はしない、`docs/fidelity.md` への導線）／`mock-bitbankcc` との棲み分け（あちらは SDK テスト用の静的スタブ）／起動方法と環境変数（`BITBANK_MOCK_CONTROL`, `BITBANK_MOCK_FILL_MODE`, `BITBANK_MOCK_STATE_PATH`）／`/_control/` の説明／非目標
- `docs/design.md` は旧 MVP 設計として残すが、冒頭に「プラン A の計画は `plan-lab-mock.md`、挙動の根拠は `fidelity.md`」と注記。ダッシュボード等の記述は「対象外」と明示
- LICENSE は MIT のまま（transfer 後も author 表記を維持するか bitbankinc 側と確認）
- transfer 後、`tjackiet/bitbank-mock-api` は GitHub のリダイレクトに任せる

---

## 8. リスクと退避策

| リスク | 兆候 | 対応 |
|---|---|---|
| Phase 1 が 9/26 を越える | 9/24 時点で routes テストが赤のまま | **R1 最小版に切り替える**: v3 モデルは入れず、`history` と新設の `canceledOrders[]` から `GET order` を組み立てる。`ordered_at` の誤りは対応表に明記して Nyx に伝える。R3 は 11 月へ。この場合 R2 の `fill` は現行 `applyFill` を直接呼ぶ |
| 実市場の足で勝手に約定してシナリオが崩れる | Nyx の結合確認で再現性が無いと報告 | control 有効時は `FILL_MODE=manual` が既定（3.3 節、決定済み）。残るのは明示的に `market` を指定した場合のみ |
| 公式 doc に無い挙動を推測で決めた箇所が仕様に漏れる | | 対応表の「推測」列と PR テンプレのチェックで機械的に拾う。API 担当レビューを 10/13 週に固定 |
| bitbankinc への transfer が遅れる | | コードは `tjackiet` 配下で v0.1.0 を切って Nyx に渡せる。README の免責は transfer 前から入れておく |
| **bitbank-lab-mcp が接続先を差し替えられない**（本リポジトリ外の前提条件） | MCP → DCL → モックの経路が組めず、Nyx が DCL 単体でしか試験できない | MCP のメンテナが本計画の依頼者本人のため、MCP 側で base URL の上書き手段（環境変数）を足す。急ぎではなく、当面は Nyx が DCL のテストから直接モックを叩く形で進められる |
| `orders_info` に存在しない ID が含まれない挙動を DCL が想定していない | リコンサイルで snapshot が届かず、DCL が Grant を stale にして fail-closed し続ける | 対応表の該当行を Nyx に事前共有し、DCL 側で「N 回引いても現れない ID は取引所に存在しない」と扱う規則を入れてもらう |

---

## 9. 要判断事項（2026-09-11 にすべて決定済み）

1. ~~`BITBANK_MOCK_CONTROL=1` のときの `FILL_MODE` 既定を `manual` にするか~~ → **決定: `manual` を既定にする**（2026-09-11、3.3 節に反映済み）
2. ~~注文 ID を連番にするか~~ → **決定: 単純な連番**（2026-09-11、3.1 節）。桁数が本物と異なる点は対応表に記録
3. ~~指値約定の手数料をどうするか~~ → **決定: プラン A はテイカー 0.12% 固定を維持し、対応表に載せる**（2026-09-11）。プラン A の Exposure（累積約定代金）に手数料は乗らず、DCL は `assets` を読まないため影響しない。プラン B で `loss_limit` を有効にすると「手数料を損失に含める」既定値が効くので、その時点で `GET /spot/pairs` の maker/taker 料率を取得する方式に切り替える候補（bitbank-lab-cli の paper エンジンに 24 時間キャッシュ付きの実装があり移植可能）
4. ~~`fast-check` の導入可否~~ → **決定: 導入する**（2026-09-11、4.3 節の `invariants.test.ts`）
5. ~~R4 のトランスポートを素の WebSocket でよいか~~ → **決定: 素の WebSocket で提供する**（2026-09-11、3.4 節）。DCL 側の接続層を差し替え可能にしてもらう点だけ Nyx に伝える
6. ~~bitbank-lab-mcp の接続先上書きを誰がいつ入れるか~~ → **決定: MCP のメンテナ（本計画の依頼者本人）が MCP 側で対応する**（2026-09-11）。本リポジトリからは環境変数名の提案（`BITBANK_API_BASE_URL`）だけ出す
7. ~~Nyx に最新版の提案書本編をもらうか~~ → **決定: 追わない**（2026-09-11）。別紙の「v1.6」は誤記の可能性が高い。対応表の出典は手元の本編 v1.0 の節番号に合わせ、Nyx から改版が届いたときに直す
