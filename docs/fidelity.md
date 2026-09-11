# モック挙動の対応表（Fidelity Matrix）

この表は bitbank API に対する本モックの互換範囲と意図的な差異を記録する、Nyx Foundation 共同研究の前提条件書である。公式ドキュメントに明記されない挙動を決めたときは、実装と同じ PR で必ず追記する。

最終確認は Phase 4 で行う。現時点の状態は **draft**。

## 出典

- [bitbank Private REST API](https://github.com/bitbankinc/bitbank-api-docs/blob/0badd68019646171826625b074cfef4235c3e713/rest-api.md)（2026-09-11 確認）
- [bitbank error codes](https://github.com/bitbankinc/bitbank-api-docs/blob/0badd68019646171826625b074cfef4235c3e713/errors.md)（2026-09-11 確認）
- [bitbank pair list](https://github.com/bitbankinc/bitbank-api-docs/blob/0badd68019646171826625b074cfef4235c3e713/pairs.md)（2026-09-11 確認）
- 提案書 兼 技術仕様案 v1.0 / 技術別紙 v1.0（2026-08-20、Nyx Foundation）

## 対応表

| 項目 | モックの挙動 | 根拠 | 本物との差異 | 推測 | DCL / 証明への含意 |
| --- | --- | --- | --- | --- | --- |
| 注文照会 | Phase 2 で `GET /v1/user/spot/order` と `POST /v1/user/spot/orders_info` を実装する | REST API: Fetch order information / Fetch multiple orders | 実装前 | いいえ | `orders_info` を Reconcile の主経路にする |
| 存在しない単一注文 ID | `GET order` は `50009` を返す予定 | 公式は「3 か月超の終端注文は 50009」のみ明記 | 存在しない ID 自体の明記はない | はい | snapshot を取得できない注文は DCL が stale / fail-closed と扱う |
| 存在しない一括照会 ID | `orders_info` はエラーにせず該当 ID を `orders` から除外する予定 | 公式は「3 か月超の終端注文は返さない」と明記 | 存在しない ID への適用は未明記 | はい | Nyx 側は欠落 ID の再照会上限を持つ必要がある |
| 注文状態 | `INACTIVE` を含む公式の 7 値を `OrderRecord.status` に持つ。Plan A で `INACTIVE` は到達しない | REST API: Fetch order information | 逆指値等は未実装 | いいえ | 終端状態の不変性を検証対象にする |
| 注文 ID | 状態の `nextOrderSeq`（初期値 1）を永続化し、発注のたびに単調増加させる | 公式は数値の order id を定義 | 実取引所の桁数・採番方式とは異なる。v2 から移行した巨大 ID（旧 `Date.now() * 1000 + counter`）がある場合は、その最大値 + 1 から続くので桁が大きく残る | はい | シナリオの再現性と再起動後の一意性を優先 |
| trade ID | 注文 ID とは別の `nextTradeSeq`（初期値 1）を永続化する。v2 の `history.id` は使わず 1 から振り直す | 公式の trade history は trade_id を持つ | 本物の採番とは一致しない | はい | 部分約定でも trade を一意に参照できる |
| 成行注文の記録 | 成行も `OrderRecord` を採番し、即時 `fillOrder` して `FULLY_FILLED` として残す | 公式は成行も order id を返す | 旧モックは成行を `history` にだけ入れ、注文レコードを持たなかった | はい | Phase 2 の ID 照会で成行も引ける前提になる |
| v2 からの移行 | 旧 `openOrders` は `UNFILLED`、旧 `history` は `FULLY_FILLED` + `trades`。`history.filledAt` を移行後の `orderedAt` とする | 旧 state に発注時刻がない | 移行済み注文の `ordered_at` は真の発注時刻ではない | はい | 既存ローカル state の照会結果は研究データに使わない |
| 指値の約定価格 | `fillOrder()` は指値に対し、買いは `price <= order.price`、売りは `price >= order.price` だけを受け付ける。成行には適用しない。違反は状態を変えず `INVALID_PRICE` | 指値注文の `price` は order price と定義される（REST API: Create new order） | 約定可能価格の明文規定は確認できていない | はい（2026-09-11 に研究要件として決定） | `reserved = price × size` を上限とする Nyx の予算不変量を守る |
| 手数料 | Plan A は maker / taker 表示に関わらずテイカー 0.12% 固定で計算する | 計画書 9 節の決定 | 実取引所は通貨ペア・maker/taker 別の料率 | はい | Exposure は手数料を含めない。Plan B で見直す |
| 拘束額 | 買いの `locked_amount` は注文残量の価格と手数料から計算する | 現行 `computeLocked()` | 本物が手数料を拘束額に含めるか公式 docs に明記なし | はい | DCL の `reserved`（手数料なし）との差を考慮する |
| 数量・価格の精度 | btc_jpy は数量 4 桁、価格 0 桁に量子化・固定小数文字列化する予定 | pair list / `GET /spot/pairs` | Plan A は btc_jpy に限定 | いいえ | 円・satoshi の整数表現との変換誤差を防ぐ |
| 取消済み・約定済みの取消 | Phase 2 でそれぞれ `50026` / `50027` を返す予定 | error codes | 現行はどちらも `50009` | いいえ | 終端状態の識別を保つ |
| エラーコード | Phase 2 で残高不足は `60001`、必須項目欠落は対応する公式コードへ是正する予定 | error codes | 現行の一部コードは誤用。全 error code の網羅はしない | いいえ | DCL がコードで失敗原因を区別できる |
| 注文の固定フィールド | **Phase 2 で実装予定**: `post_only: false`、`expire_at: null`、`user_cancelable` はアクティブ注文だけ `true` | REST API: Fetch order information | post only・期限・注文訂正を実装しない | はい | DCL はこれらの値で分岐しない前提 |
| maker / taker 表示 | 指値の trade は `maker`、成行は `taker` と表示する | REST API の trade history | 手数料がテイカー固定 0.12% であり、指値の表示と計算が整合しない | はい | Plan A の Exposure 判定には影響しない |
| 注文訂正 | 注文訂正 API を提供しない | Nyx 提案書 14.1 | bitbank の対応可否も含め、本モックの対象外 | いいえ | DCL は発注後の価格・数量変更を前提にしない |
| 部分約定を取り消した注文 | `CANCELED_PARTIALLY_FILLED` でも `executed_amount` と trade 記録を保持する予定 | REST API の status enum、Nyx 提案書 14.1 | 現行は部分約定を持たない | はい | DCL の累計約定量は取消後も減らない |
| 成行注文の価格上限 | 成行に価格上限は設けない予定 | Nyx 提案書 14.1 | 指値だけに価格制約を適用する | はい | 価格上限が必要な実験は指値で行う |
| 認証 | Plan A は認証ヘッダを検証しない | REST API は private API に認証を要求 | 意図的に未実装 | はい | DCL の HMAC 送信は通過するが認証の検証対象にはしない |
| レート制限 | 実装しない | REST API: QUERY 10/s、UPDATE 6/s、超過時 429 | 意図的に未実装 | いいえ | 負荷・429 復旧の実験には使えない |
| `/_control/` | `BITBANK_MOCK_CONTROL=1` のときだけ、ローカル実験用の状態操作 API を公開する予定 | 本モック固有 | bitbank API に存在しない | はい | DCL / 本番 API の仕様に control の存在を混入させない |
| control 時の自動約定 | control 有効時の既定を `BITBANK_MOCK_FILL_MODE=manual` とし、明示指定時だけ市場連動 tick を行う予定 | 計画書 9 節の決定 | 本物の取引所には対応する切替がない | はい | 同一シナリオを市場価格に依存せず再現できる |
| private stream | Phase 5 で PubNub ではなく素の WebSocket を提供する予定 | private stream docs のメッセージ形 | 接続・配信トランスポートが異なる | はい | Nyx 側は PubNub SDK ではなく WebSocket 接続層を使う |
| private stream の順序 | 配信順序・重複なしを保証しない | private stream docs に順序保証の記載なし | Plan A では障害注入は提供しない | はい | DCL は順不同・重複を許容して状態を解釈する |

## 状態の不変量（PaperState v3）

`src/engine/invariants.ts` と `tests/engine/invariants.test.ts` で検証する。Nyx 仕様書 D1 の前提になる。

1. `0 <= executedAmount <= startAmount`
2. `status ∈ {INACTIVE, UNFILLED}` ⇔ `executedAmount == 0` かつ非終端（`INACTIVE` は Plan A では到達しない）
3. `status == FULLY_FILLED` ⇔ `executedAmount == startAmount`（`startAmount > 0`）
4. 終端状態（`FULLY_FILLED` / `CANCELED_*` / `REJECTED`）のレコードは以後の遷移で変化しない
5. 各注文について、`trades` の `amount` 合計 == `executedAmount`、かつ `amount × price` 合計 == `executedNotional`
6. 各資産で残高は負にならず、`locked` は残高を超えない（`availableOf >= 0`。買いの拘束額は手数料込み）

そのほか Phase 1 で決めた内部規則:

- ペアは `base_quote` の 2 セグメントだけを受け付ける。`btc_jpy_x` のような余剰セグメントは `INVALID_PAIR`
- `fillOrder` は残量との差が `1e-12` 以下なら全量約定として残量にクランプする（倍精度の塵で終端に届かないことを防ぐ。Phase 2 の桁数量子化が主防御）
- `rejectOrder` は `UNFILLED` / `INACTIVE`（`executedAmount == 0`）にだけ許す。部分約定済みは `CANCELED_PARTIALLY_FILLED` へ取消する
