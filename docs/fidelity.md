# モック挙動の対応表（Fidelity Matrix）

この表は bitbank API に対する本モックの互換範囲と意図的な差異を記録する、Nyx Foundation 共同研究の前提条件書である。公式ドキュメントに明記されない挙動を決めたときは、実装と同じ PR で必ず追記する。

**状態: v0.1.0 / Plan A 凍結**（2026-09-11）。Nyx への引き渡しはこの版を前提にする。以後の変更は改訂として記録する。API 担当レビュー後に「確認済み／要修正」列を足す。private stream（R4）は Phase 5 の予定行のまま。

## 出典

- [bitbank Private REST API](https://github.com/bitbankinc/bitbank-api-docs/blob/0badd68019646171826625b074cfef4235c3e713/rest-api.md)（2026-09-11 確認）
- [bitbank error codes](https://github.com/bitbankinc/bitbank-api-docs/blob/0badd68019646171826625b074cfef4235c3e713/errors.md)（2026-09-11 確認）
- [bitbank pair list](https://github.com/bitbankinc/bitbank-api-docs/blob/0badd68019646171826625b074cfef4235c3e713/pairs.md)（2026-09-11 確認）
- 提案書 兼 技術仕様案 v1.0 / 技術別紙 v1.0（2026-08-20、Nyx Foundation）

## 対応表

| 項目 | モックの挙動 | 根拠 | 本物との差異 | 推測 | DCL / 証明への含意 |
| --- | --- | --- | --- | --- | --- |
| 注文照会 | `GET /v1/user/spot/order`（query: `pair`, `order_id`）と `POST /v1/user/spot/orders_info`（body: `pair`, `order_ids`）を実装する。ヒットした `OrderRecord` を `formatOrder()` で返す | REST API: Fetch order information / Fetch multiple orders | 3 か月超の履歴削除はしない。モック上の全注文が引ける | いいえ | `orders_info` を Reconcile の主経路にする |
| 存在しない単一注文 ID | `GET order` は `50009` を返す。`pair` 不一致も `50009` | 公式は「3 か月超の終端注文は 50009」のみ明記 | 存在しない ID 自体の明記はない | はい | snapshot を取得できない注文は DCL が stale / fail-closed と扱う |
| 存在しない一括照会 ID | `orders_info` はエラーにせず該当 ID を `orders` から除外する。0 件でも `success: 1`。応答順はリクエストの `order_ids` 順 | 公式は「3 か月超の終端注文は返さない」と明記 | 存在しない ID への適用と配列順は未明記 | はい | Nyx 側は欠落 ID の再照会上限を持つ必要がある |
| 注文状態 | `INACTIVE` を含む公式の 7 値を `OrderRecord.status` に持つ。Plan A で `INACTIVE` は到達しない | REST API: Fetch order information | 逆指値等は未実装 | いいえ | 終端状態の不変性を検証対象にする |
| 注文 ID | 状態の `nextOrderSeq`（初期値 1）を永続化し、発注のたびに単調増加させる | 公式は数値の order id を定義 | 実取引所の桁数・採番方式とは異なる。v2 から移行した巨大 ID（旧 `Date.now() * 1000 + counter`）がある場合は、その最大値 + 1 から続くので桁が大きく残る | はい | シナリオの再現性と再起動後の一意性を優先 |
| trade ID | 注文 ID とは別の `nextTradeSeq`（初期値 1）を永続化する。v2 の `history.id` は使わず 1 から振り直す | 公式の trade history は trade_id を持つ | 本物の採番とは一致しない | はい | 部分約定でも trade を一意に参照できる |
| 成行注文の記録 | 成行も `OrderRecord` を採番し、即時 `fillOrder` して `FULLY_FILLED` として残す | 公式は成行も order id を返す | 旧モックは成行を `history` にだけ入れ、注文レコードを持たなかった | はい | Phase 2 の ID 照会で成行も引ける前提になる |
| v2 からの移行 | 旧 `openOrders` は `UNFILLED`、旧 `history` は `FULLY_FILLED` + `trades`。`history.filledAt` を移行後の `orderedAt` とする | 旧 state に発注時刻がない | 移行済み注文の `ordered_at` は真の発注時刻ではない | はい | 既存ローカル state の照会結果は研究データに使わない |
| 指値の約定価格 | `fillOrder()` は指値に対し、買いは `price <= order.price`、売りは `price >= order.price` だけを受け付ける。成行には適用しない。違反は状態を変えず `INVALID_PRICE` | 指値注文の `price` は order price と定義される（REST API: Create new order） | 約定可能価格の明文規定は確認できていない | はい（2026-09-11 に研究要件として決定） | `reserved = price × size` を上限とする Nyx の予算不変量を守る |
| 手数料 | Plan A は maker / taker 表示に関わらずテイカー 0.12% 固定で計算する | 計画書 9 節の決定 | 実取引所は通貨ペア・maker/taker 別の料率 | はい | Exposure は手数料を含めない。Plan B で見直す |
| 拘束額 | 買いの `locked_amount` は注文残量の価格と手数料から計算する | 現行 `computeLocked()` | 本物が手数料を拘束額に含めるか公式 docs に明記なし | はい | DCL の `reserved`（手数料なし）との差を考慮する |
| 数量・価格の精度 | 応答の数量はペア桁で `toFixed`（btc_jpy は数量 4 桁 `"0.0010"`、価格 0 桁 `"5000000"`）。未登録ペアも同じ桁を仮置きする。発注 `amount` が桁に収まらなければ `60004`。trade の `fee_amount_quote` は JPY 4 桁 | pair list / `GET /spot/pairs` の `amount_digits` / `price_digits` | 公式 `60004` は「数量がしきい値を下回る」。モックは桁溢れ拒否に流用。価格の桁溢れは `20003`。ゼロ数量は `"0.0000"`、未約定の `average_price` だけは `"0"` | はい（60004 の流用・未登録ペアの桁・fee 桁） | 円・satoshi の整数表現との変換誤差を防ぐ |
| 残高の桁 | `GET /v1/user/assets` の `free_amount` / `onhand_amount` / `locked_amount` は、同じ応答で宣言する `amount_precision` の桁の固定桁 10 進文字列で返す（jpy は 4 桁 `"9892.0000"`、他資産は 8 桁 `"0.50000000"`）。残高と拘束額をその桁の最小単位の整数（`bigint`）へ四捨五入してから `free = onhand - locked` を整数で引くので、応答の 3 値の間でこの等式が文字列として成り立つ。倍精度の乗除を挟まないため、`Number.MAX_SAFE_INTEGER` を超える残高でも指数表記に落ちない。非有限な残高（壊れた state）だけは丸めずそのまま出す | REST API: Fetch asset（応答は文字列の金額と `amount_precision` を持つ）。桁の値 4 / 8 は本モックの既存宣言を踏襲 | 本物が丸めか切り捨てか、3 値をどう整合させるかは公式 docs に明記がない。モックは四捨五入（端数は `Math.round` と同じく +∞ 方向）で統一する。engine の内部演算は倍精度のままで、丸めは応答文字列だけに効く | はい（丸め方向、jpy 以外を一律 8 桁とすること、free を差で組み立てること）。いいえ（`amount_precision` の存在と金額が文字列であること） | 円建て残高が整数に落ちるので、Nyx 側は最小単位（円 / satoshi）へ入口で丸め直さずに取り込める。表示の丸めで負値を 0 にクランプはしないため、`locked > 残高` は `free_amount` が負のまま現れる。残高の非負・`locked <= 残高` は引き続き不変量 6（`src/engine/invariants.ts`）で検査する |
| 資産応答の固定フィールド | `GET /v1/user/assets` は公式の応答表にあるフィールドを全て返す。`withdrawing_amount` は出金を実装しないので常に 0（残高と同じ固定桁）。`withdrawal_fee` は公式と同じ形のオブジェクトで、jpy は `{under, over, threshold}`、他資産は `{min, max}`。値は全て 0。`collateral_ratio` は信用取引を実装しないので `"0"` 固定。`network_list` は jpy では省略し、他資産では常に空配列 | REST API: Fetch asset の応答表（`withdrawing_amount` / `withdrawal_fee` / `network_list` / `collateral_ratio`） | 本物は資産・ネットワークごとの実際の出金手数料と代用掛け目を返し、`network_list` に対応ネットワークを列挙する。本モックは出金・信用取引・ネットワークのいずれも模さない | はい（0 固定・掛け目 0・空配列。フィールドの存在と形は公式どおりで、いいえ） | Nyx は出金手数料・代用掛け目・ネットワーク一覧を判断材料にしない。値が 0 であることを「手数料無料」「担保価値なし」と解釈せず、未実装の印として扱う |
| 平均約定価格の丸め | `average_price = executedNotional / executedAmount` を価格桁に四捨五入（`executedAmount == 0` なら除算せず `"0"`）。部分約定で平均が価格単位に乗らないとき、`executed_amount × average_price` と約定代金の差は `executed_amount × 価格単位 × 0.5` 以下 | REST API の `average_price` は文字列 | 内部は JS 倍精度のまま。丸めは応答文字列だけ | はい | DCL が `committed` をこの積で再計算すると同じ誤差が乗る |
| 取消済み・約定済みの取消 | 取消済み（`CANCELED_*`）は `50026`、約定済み（`FULLY_FILLED`）は `50027`。`REJECTED` は `50009`。`cancel_orders` はリクエスト順で終端が混ざるとエラーを返し、1 件も取消しない | error codes | 公式のバッチ混在時の挙動は未確認。`REJECTED` への取消コードも未明記 | はい（REJECTED とバッチ fail-closed） | 終端状態の識別を保つ。部分成功は起きない |
| エラーコード | 残高不足 `60001`。欠落: amount `30001`、price `30012`、side `30013`、type `30015`、order_id `30006`、order_ids `30007`。その他の不正値は `20003`（公式の ACCESS-KEY 欠落コードをパラメータエラーに流用）。不正なペアは `10000`（公式の `10000` は SYSTEM_ERROR の「Url not found.」。errors.md に現物の「不正なペア」を表すコードが無いための流用） | error codes | 全 error code は網羅しない。HTTP は欠落・不正値を 400、業務エラーを 200 のまま。`src/routes/envelope.ts` の `ErrorCode` に errors.md で定義されない番号は置かない | はい（`20003` と `10000` の流用、HTTP 区分） | DCL がコードで失敗原因を区別できる。`10000` と `20003` は公式と意味が違うので、コードの意味を errors.md から引かない |
| 注文の固定フィールド | `post_only: false` は `type == limit` のときだけ出す（成行では省略。`price` の有無とは独立で、`price` を持たない指値でも出る）。`expire_at: null`。`user_cancelable` はアクティブ注文だけ `true`。成行の `price` は省略し `average_price` に約定値を載せる | REST API: Fetch order information の応答表（`price` は「type = `limit` または `stop_limit` 時のみ」、`post_only` は「type = `limit` 時のみ」と別条件で定義される） | post only・期限・注文訂正を実装しない。`post_only` を `true` にする経路は無い | はい（値が常に false であること）。いいえ（出現条件は公式どおり） | DCL はこれらの値で分岐しない前提 |
| 注文の `canceled_at` | 取消済み（`canceledAt` を持つ注文）のときだけ出す。取消系の 2 経路（`cancel_order` / `cancel_orders`）では必ず出て、未約定・約定済みの注文を `GET order` / `orders_info` / `active_orders` で引いたときは出ない。取消済み注文を `GET order` / `orders_info` で引くと出る | REST API: **Cancel order の応答表**（`canceled_at \| number \| canceled at unix timestamp (milliseconds)`）。この項目を応答表に持つ節は Cancel order だけで、Fetch order information の表には無い | **未確定。** 公式の記述では決め切れない。(a) Fetch order information の応答表に `canceled_at` は載っていない。(b) Fetch multiple orders の応答例 JSON には `"canceled_at": 0` が入るが、あの例は全フィールドをダミー値で並べた雛形で、常に返る証拠にならない。(c) Fetch active orders の応答例 JSON には入っていない（アクティブな注文は取消済みになりえないので、どちらの解釈とも矛盾しない）。(d) 英語版は Cancel order の型を `number`、日本語版は `number \| undefined` と書いており、両版で食い違う。本物が取消済み注文の照会で常に返すのか、Cancel order の応答でだけ返すのかは確認できていない | はい（照会経路で出すかどうかの選択）。いいえ（Cancel order の応答に出ること） | Nyx は `canceled_at` の**有無**を取消判定に使わない。取消は `status`（`CANCELED_UNFILLED` / `CANCELED_PARTIALLY_FILLED`）で判定する |
| active_orders の絞り込み | `count` / `from_id` / `end_id` / `since` / `end` を受け、生成順のまま絞る。`from_id`/`end_id` は inclusive、`since`/`end` は `ordered_at` のミリ秒 inclusive | REST API: Fetch active orders | 公式の since/end が秒かミリ秒かは明記なし | はい | 発注応答を取りこぼした DCL が自分の注文を探す経路 |
| trade_history の絞り込み | `order_id` / `since` / `end` / `order(asc\|desc)` を追加。既定は `desc`（新しい順）。`count` 指定時は最大 1000。未指定なら全件 | REST API: Fetch trade history | 公式の既定件数は未確認。モックは未指定で全件返す | はい | DCL が注文単位で約定を突き合わせられる |
| 約定の固定フィールド | `formatTrade()` は公式の「Fetch trade history」の応答表のうち、現物で意味を持つ 12 フィールドを全て返す。`fee_occurred_amount_quote` は公式が「現物取引では `fee_amount_quote` と同値」と明記するので同値を返す。`fee_amount_base` は base 資産の手数料を取らないので常に `"0"` | REST API: Fetch trade history の応答表（`fee_occurred_amount_quote \| string \| quote fee occurred amount which taken later. In case of spot trading, this value is same as fee_amount_quote.`） | `fee_amount_base` の桁の刻み方は公式に記載が無く、本モックは桁を付けない素の `"0"` を返す（`fee_amount_quote` は jpy の 4 桁）。本物が `"0.00000000"` のような固定桁を返すかは**要追加確認** | はい（`fee_amount_base` の表記）。いいえ（`fee_occurred_amount_quote` の値） | Nyx は quote 手数料を `fee_amount_quote` と `fee_occurred_amount_quote` のどちらから読んでも同じ値になる。`fee_amount_base` の文字列表記に桁を仮定しない |
| 信用取引・逆指値の項目 | 公式の応答表にあっても、本モックが機能を実装しないフィールドはキー自体を出さない。注文: `position_side` / `triggered_at` / `trigger_price`。約定: `position_side` / `profit_loss` / `interest` | REST API の各応答表（`position_side` は「only for margin trading」、`triggered_at` / `trigger_price` は「present only if type = `stop`, `stop_limit`, `take_profit`, `stop_loss`」と条件が明記される） | `profit_loss` / `interest` は型が `string \| undefined` とだけ書かれ、省略条件の明記が無い。信用取引の項目なので現物では出ないと判断した（**推測**） | はい（`profit_loss` / `interest` を出さない判断）。いいえ（その他は公式の条件どおり） | Nyx はこれらのキーの存在を前提にしない。省略は未実装の印であって、値 0 の意味ではない |
| 配列の包み方 | `orders_info` / `active_orders` / `cancel_orders` は `data.orders`、`trade_history` は `data.trades` に配列を置き、`data` 直下に他のキーを持たない | REST API: Fetch multiple orders / Fetch active orders / Cancel multiple orders は `orders \| Array`、Fetch trade history の応答例は `data.trades` | 差異なし | いいえ | Nyx は配列の位置を固定して読める |
| 注文オブジェクトの共通形 | 注文を返す 5 経路（`GET order` / `POST order` / `cancel_order` / `orders_info` / `active_orders`）は `formatOrder()` の 1 つの整形関数を共有する。経路ごとの形の違いは `canceled_at` の有無だけで、それも注文が取消済みかどうかで決まる | REST API: Fetch multiple orders と Fetch active orders は応答を「list of object same as [Fetch order information response]」と定義し、Cancel multiple orders は「list of object same as [Cancel order response]」と定義する。Cancel order の応答表は Fetch order information の表に `canceled_at` を足したもの | 差異なし | いいえ | 経路ごとに別のパーサを持つ必要はない |
| maker / taker 表示 | 指値の trade は `maker`、成行は `taker` と表示する | REST API の trade history | 手数料がテイカー固定 0.12% であり、指値の表示と計算が整合しない | はい | Plan A の Exposure 判定には影響しない |
| 注文訂正 | 注文訂正 API を提供しない | Nyx 提案書 14.1 | bitbank の対応可否も含め、本モックの対象外 | いいえ | DCL は発注後の価格・数量変更を前提にしない |
| 部分約定を取り消した注文 | `CANCELED_PARTIALLY_FILLED` でも `executed_amount` と trade 記録を保持する | REST API の status enum、Nyx 提案書 14.1 | 本物の保持期間（3 か月）はモックに無い | はい | DCL の累計約定量は取消後も減らない |
| 成行注文の価格上限 | 成行に価格上限は設けない | Nyx 提案書 14.1 | 指値だけに価格制約を適用する | はい | 価格上限が必要な実験は指値で行う |
| 認証 | Plan A は認証ヘッダを検証しない | REST API は private API に認証を要求 | 意図的に未実装 | はい | DCL の HMAC 送信は通過するが認証の検証対象にはしない |
| レート制限 | 実装しない | REST API: QUERY 10/s、UPDATE 6/s、超過時 429 | 意図的に未実装 | いいえ | 負荷・429 復旧の実験には使えない |
| `/_control/` | `BITBANK_MOCK_CONTROL=1` のときだけ登録する。素の JSON（bitbank 封筒ではない）。`POST /_control/orders/:id/fill`、`POST /_control/tick`、`POST /_control/reset`、`GET /_control/state`。無効時は 404 | 本モック固有 | bitbank API に存在しない | はい | DCL / 本番 API の仕様に control の存在を混入させない |
| control のアクセス境界 | control 有効時の listen 既定は `127.0.0.1`（`BITBANK_MOCK_HOST` で上書き可）。非ループバックは `X-Control-Token` が `BITBANK_MOCK_CONTROL_TOKEN` と一致しない限り 403。トークン未設定なら非ループバックは常に 403 | 本モック固有 | 本物の取引所には無い | はい | 同一ネットワークからの誤操作を防ぐ。DCL は control を叩かない |
| control 時の自動約定 | control 有効時の既定は `BITBANK_MOCK_FILL_MODE=manual`。`store.tick()` は足を取らず約定しない。明示で `market` にすると REST 経路は現行どおり市場連動 | 計画書 9 節の決定 | 本物の取引所には対応する切替がない | はい | 同一シナリオを市場価格に依存せず再現できる |
| control の fill / tick 検証 | 存在しない注文 404、終端 409。`amount` が非正・残量超過・桁溢れは 400 `INVALID_AMOUNT`。`price` が非正・非有限は 400 `INVALID_PRICE`。足は `0 < low <= open <= high` かつ `low <= close <= high` の有限値。拒否時は状態を変えない | 本モック固有（不変量 1 の防御） | 本物には無い | はい | 実験用の部分約定は control からのみ起こす。DCL の通常経路では使わない |
| 状態の永続化 | 発注・取消・約定のたびに `PaperState` 全体を状態ファイルへ書き出す。書き出しは一時ファイル + `rename` で原子的なので、読み手が途中の内容を見ることはない。同一プロセス内の書き込みは `SessionStore.persist()` で直列化する。`await store.persist()` が返った時点で、ファイルは**呼び出し時点の状態と同じか、それより新しい状態**を反映する。重なった書き込みは 1 本にまとめ、途中のスナップショットは捨てるが、最後の 1 本は必ず着地する | 本モック固有（`src/store/session.ts` / `src/engine/persist.ts`） | 本物の取引所はクライアント側に口座状態の永続化を持たせない | はい | 2xx を受け取った注文は再起動後も状態ファイルに残る。Nyx の認可層は応答を受けた注文を再起動後のリコンサイル対象にしてよい。ただしディレクトリの fsync はしないので、OS ごと落ちた場合の `rename` の耐久性までは保証しない（プロセスの再起動は保証範囲） |
| 同一状態ファイルの多重起動 | **保証しない。** ファイルロックを持たない。同じ `BITBANK_MOCK_STATE_PATH` を指す 2 プロセスを同時に動かすと、各プロセスが独立したメモリ上の状態と `nextOrderSeq` を持ち、後から `rename` した側が相手の注文を丸ごと消す。両プロセスが同じ order id を採番して払い出すことも起きる。状態ファイル 1 つにつきプロセス 1 つで運用する | 本モック固有 | 本物は口座状態を取引所側が単一に持つ | はい（ロックを足さない判断。書き込みロックを入れてもプロセスごとにメモリ上の状態と採番が分かれる以上、注文の消失と id 重複は防げないため、運用の制約として書くことを選んだ） | 実験は 1 プロセスで走らせる。並列度が要るときは `BITBANK_MOCK_STATE_PATH` をシナリオごとに分ける |
| 壊れた状態ファイル | fail-closed。不正な JSON・スキーマ違反・途中で切れたファイル・空ファイルはいずれも `loadState` が失敗を返し、`loadOrInitDefault` が throw して起動しない。黙って初期状態へ戻さず、壊れたファイルも消さない。ファイルが存在しないときだけ初期状態で始める | 本モック固有 | 本物には対応する概念がない | はい | 「残高が初期値に戻っている」状態でシナリオが進むことはない。起動しなかったこと自体を state 破損の合図として扱える |
| 状態の移行の冪等性 | v1 / v2 の状態ファイルを v3 へ移行する変換は決定的で、移行後の v3 を書き戻してもう一度読んでも結果は変わらない | 本モック固有 | 本物には対応する概念がない | いいえ | 旧 state から始めたシナリオでも、再起動のたびに注文・trade が動くことはない |
| private stream | Phase 5 で PubNub ではなく素の WebSocket を提供する予定 | private stream docs のメッセージ形 | 接続・配信トランスポートが異なる | はい | Nyx 側は PubNub SDK ではなく WebSocket 接続層を使う |
| private stream の順序 | 配信順序・重複なしを保証しない | private stream docs に順序保証の記載なし | Plan A では障害注入は提供しない | はい | DCL は順不同・重複を許容して状態を解釈する |

## 状態の不変量（PaperState v3）

`src/engine/invariants.ts` と `tests/engine/invariants.test.ts` で検証する。Nyx 仕様書 D1 の前提になる。

1. `0 <= executedAmount <= startAmount`
2. `status ∈ {INACTIVE, UNFILLED}` ⇔ `executedAmount == 0` かつ非終端（`INACTIVE` は Plan A では到達しない）。`CANCELED_UNFILLED` / `REJECTED` も `executedAmount == 0`。`CANCELED_PARTIALLY_FILLED` は `executedAmount > 0`
3. `status == FULLY_FILLED` ⇔ `executedAmount == startAmount`（`startAmount > 0`）
4. 終端状態（`FULLY_FILLED` / `CANCELED_*` / `REJECTED`）のレコードは以後の遷移で変化しない
5. 各注文について、`trades` の `amount` 合計 == `executedAmount`、かつ `amount × price` 合計 == `executedNotional`。`orderId` が注文に存在しない trade は禁止
6. 各資産で残高は負にならず、`locked` は残高を超えない（`availableOf >= 0`。買いの拘束額は手数料込み）

そのほか Phase 1 で決めた内部規則:

- ペアは `base_quote` の 2 セグメントだけを受け付ける。余剰セグメント（`btc_jpy_x`）と base == quote（`jpy_jpy`）は `INVALID_PAIR`。不正ペアの発注は `tick()` より前に拒否し、他注文を動かさない
- `fillOrder` は残量との差が `1e-12` 以下なら全量約定として残量にクランプし、`executedAmount` を `startAmount` に揃える（倍精度の塵で終端に届かないことを防ぐ。Phase 2 の桁数量子化が主防御）
- `rejectOrder` は `UNFILLED` / `INACTIVE`（`executedAmount == 0`）にだけ許す。部分約定済みは `CANCELED_PARTIALLY_FILLED` へ取消する
