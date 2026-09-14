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
| 封筒に包まれない応答 | 互換ルート（`/v1/user/...`）のうち、**Fastify が route ハンドラへ入る前に返す応答は bitbank 封筒ではない**。(a) `content-type: application/json` で本文が壊れた JSON（`__proto__` キーを含む本文も同じ扱い）は `{"statusCode":400,"code":"FST_ERR_CTP_INVALID_JSON_BODY",...}`、(b) 未登録のパス・メソッドは `{"message":"Route ... not found","error":"Not Found","statusCode":404}`、(c) ハンドラ内の未捕捉例外は `{"statusCode":500,...}` で例外メッセージが出る。ハンドラへ入った後の欠落・不正値は封筒（400 + `err()`）で返す | 本モック固有（Fastify の既定ハンドラ） | 本物は URL 不明を `10000`（SYSTEM_ERROR「Url not found.」）の封筒で返す。壊れた本文・内部エラーに対する本物の応答は確認できていない | はい | **未確定。** 本物が壊れた JSON 本文へ返すコードが errors.md から決められないので、封筒へ包み直す変更は入れていない（推測でコードを選ばない）。Nyx のパーサは、実装済みエンドポイントであっても `success` キーを持たない応答が返り得ることを前提にする（`success` の有無で分岐し、無ければ HTTP ステータスで扱う） |
| `/_control/` | `BITBANK_MOCK_CONTROL=1` のときだけ登録する。素の JSON（bitbank 封筒ではない）。`POST /_control/orders/:id/fill`、`POST /_control/tick`、`POST /_control/clock`、`POST /_control/reset`、`GET /_control/state`。無効時はルート自体を登録しないので、メソッド・パスによらず Fastify の既定 404（本文も他の未登録パスと同じ）。有効時は、非ループバックから見ると登録済みの（メソッド, パス）が 403、未登録が 404 になるので、どの口が在るかは区別できる | 本モック固有 | bitbank API に存在しない | はい | DCL / 本番 API の仕様に control の存在を混入させない |
| control のアクセス境界 | control 有効時の listen 既定は `127.0.0.1`（`BITBANK_MOCK_HOST` で上書き可）。非ループバックは `X-Control-Token` が `BITBANK_MOCK_CONTROL_TOKEN` と一致しない限り 403。トークン未設定なら非ループバックは常に 403。**ループバックからはトークン無しで全操作を通す**ので、同一ホスト上の別プロセス・別ユーザからの誤操作は防げない。判定に使う接続元は **TCP の対向アドレス（`request.socket.remoteAddress`）だけ**で、`X-Forwarded-For` 等のヘッダは見ない。そのため `buildServer()` の `trustProxy` の有無で境界は変わらない。**許可判定を `request.ip` に戻してはいけない**（`request.ip` は `trustProxy` を有効にすると `X-Forwarded-For` を返すので、その瞬間にヘッダ詐称で境界が消える）。トークンは `X-Control-Token` の**ヘッダ行がちょうど 1 本のときだけ**受け、0 本・2 本以上は 403（Node は同名ヘッダを `", "` 繋ぎの 1 本の文字列にするため、行数は生ヘッダで数える）。一致は `timingSafeEqual` で見る（長さの違いは隠れないので固定長で運用する） | 本モック固有 | 本物の取引所には無い | はい | 同一ネットワークからの誤操作を防ぐ。DCL は control を叩かない |
| control 時の自動約定 | control 有効時の既定は `BITBANK_MOCK_FILL_MODE=manual`。`store.tick()` は足を取らず約定しない。明示で `market` にすると REST 経路は現行どおり市場連動 | 計画書 9 節の決定 | 本物の取引所には対応する切替がない | はい | 同一シナリオを市場価格に依存せず再現できる |
| control の時計 | `POST /_control/tick` は状態の `lastTickAt` を `max(現在時刻, 前回 + 60 秒, 足の timestamp)` へ進める。1 回の tick で必ず 60 秒以上進み（1 分足が同じ実時刻の 2 本でも別の窓に落ちるため）、tick では**巻き戻らない**。**ただし実時刻より先へ進める幅は 24 時間まで**（`src/routes/control.ts` の `MAX_CLOCK_AHEAD_MS`）。足の `timestamp` が `現在時刻 + 24 時間` を超えると 400 `CANDLE_TOO_FAR_AHEAD`（`maxTimestamp` 付き）、60 秒の単調前進だけで超えるとき（＝時計が上限の 60 秒手前まで来ているとき）は 400 `CLOCK_TOO_FAR_AHEAD`（`lastTickAt` / `maxLastTickAt` 付き）で、どちらも状態を変えない。進める経路はこの 2 つだけなので、`4e12`（西暦 2096）や `1e15`（西暦 33658）を渡しても、tick を何回重ねても、時計が実時間から 24 時間より離れることはない。上限にクランプせず断るのは、足の timestamp を黙って書き換えると約定時刻（`candle.timestamp + 1 分`）がずれ、60 秒の前進を黙って縮めると同じ実時刻の 2 本が同じ窓・同じ約定時刻に落ちるため。**戻す手段は `POST /_control/clock`**（本文省略で現在時刻、`{ lastTickAt }` に ISO 文字列かエポックミリ秒で任意の時刻。注文・約定・残高はそのまま残る。範囲外の値と、本文そのものが record でないとき（配列・`null`・数値・文字列。本文の省略だけが「現在時刻へ戻す」）は 400 `INVALID_CLOCK`、`現在時刻 + 24 時間` 超は 400 `CLOCK_TOO_FAR_AHEAD`）。`POST /_control/reset`（注文・約定・残高を全部捨てる）でも戻るが、シナリオは失われる。過去の `timestamp` は今までどおり通る（上限は先の側だけに効く）。**market モードとの相互作用**: `BITBANK_MOCK_FILL_MODE=market` で `lastTickAt` が実時刻より先にあると、`SessionStore.tick()` の足の取得範囲が `(未来, 現在)` と逆転する。逆転した範囲で取った足は `runTick` の窓（`fromMs = min(lastTickAt, now)` 以上 `now` 以下）から全部外れて 1 本も約定しないので、**取得自体を飛ばし `tick: lastTickAt "..." is ahead of now "..."; skipping candle fetch` を warn で出す**（以前は逆転した範囲で問い合わせ、警告もエラーも無いまま約定が止まっていた）。この後 `SessionStore.tick()` は tick の最後で `lastTickAt` を現在時刻で上書きするので、未来へ進めた時計はそこで巻き戻り、次の tick は今までどおり取得して約定する（警告が出るのは 1 回）。この回だけは約定が 0 でも状態ファイルへ書く（書かないと再起動でファイルから未来の時計を読み直し、同じ空振りを繰り返すため）。24 時間の上限があるので、`lastTickAt` が `8.64e15 − 9 時間` を超えて market モードの足取得の日付が `NaNNaNNaN` になる経路は `/_control/tick` からは届かない | 本モック固有 | 本物の取引所には対応する概念がない | はい | **24 時間の根拠**: `runTick` が 1 回の tick で遡る上限（`MAX_LOOKBACK_MS`）と同じ幅で、1 分足なら 1 日分（1440 本）。合成の tick を 1440 回重ねるまでは今までどおり通る。#20 / #21 で入れた `timestamp` の上限（`Date` の表現範囲 − JST オフセット = `8.64e15 − 9 時間`。同じ表の「control の fill / tick 検証」行）とは別の、その内側にある制約。Nyx 側は `lastTickAt` を実時間と見なさない |
| control の fill / tick 検証 | 存在しない注文 404、終端 409。`POST /_control/tick` の `pair` は互換ルートと同じ検証（`pairAssets`）を通らなければ 400 `INVALID_PAIR`。`amount` が非正・残量超過・桁溢れは 400 `INVALID_AMOUNT`。`price` が非正・非有限は 400 `INVALID_PRICE`。足は `0 < low <= open <= high` かつ `low <= close <= high` の有限値で、`timestamp` は `Date` の表現範囲から下流の加算分を引いた範囲（`-8.64e15 <= t <= 8.64e15 − 9 時間`。上側だけ JST オフセット分の余裕を取るので非対称）に収まること。さらに `timestamp` が `現在時刻 + 24 時間` を超えるものは 400 `CANDLE_TOO_FAR_AHEAD`、60 秒の単調前進だけでその幅を超える tick は 400 `CLOCK_TOO_FAR_AHEAD`（同じ表の「control の時計」行）。`POST /_control/clock` の `lastTickAt` は ISO 文字列かエポックミリ秒で、同じ 2 つの範囲を外れると 400 `INVALID_CLOCK` / 400 `CLOCK_TOO_FAR_AHEAD`。`POST /_control/reset` の `balances` のキーは互換ルートと同じ文字種（`[a-z0-9]+`、`pairAssets` のセグメント）に限り、外れるものは 400 `INVALID_BALANCES`。拒否時は状態を変えない（`fill` / `tick` / `clock` / `reset` の全拒否経路で確認済み） | 本モック固有（不変量 1 の防御） | 本物には無い | はい | 実験用の部分約定は control からのみ起こす。DCL の通常経路では使わない |
| 状態の永続化 | 発注・取消・約定のたびに `PaperState` 全体を状態ファイルへ書き出す。書き出しは一時ファイル + `rename` で原子的なので、読み手が途中の内容を見ることはない。同一プロセス内の書き込みは `SessionStore.persist()` で直列化する。`await store.persist()` が返った時点で、ファイルは**呼び出し時点の状態と同じか、それより新しい状態**を反映する。重なった書き込みは 1 本にまとめ、途中のスナップショットは捨てるが、最後の 1 本は必ず着地する | 本モック固有（`src/store/session.ts` / `src/engine/persist.ts`） | 本物の取引所はクライアント側に口座状態の永続化を持たせない | はい | 書き込みが成功していれば、2xx を受け取った注文は再起動後も状態ファイルに残る。**ただし 2xx だけでは書き込みの成否を判定できない。** 書き込みに失敗したとき（ディスク不足・権限など）、`persist()` は `persist failed: ...` を warn ログへ出すだけで throw せず、ルートは 2xx を返す。応答を返した注文が再起動後に消える経路がここに残るので、実験中は警告ログを監視する。またディレクトリの fsync はしないので、OS ごと落ちた場合の `rename` の耐久性も保証しない（プロセスの再起動は保証範囲） |
| 同一状態ファイルの多重起動 | **保証しない。** ファイルロックを持たない。同じ `BITBANK_MOCK_STATE_PATH` を指す 2 プロセスを同時に動かすと、各プロセスが独立したメモリ上の状態と `nextOrderSeq` を持ち、後から `rename` した側が相手の注文を丸ごと消す。両プロセスが同じ order id を採番して払い出すことも起きる。状態ファイル 1 つにつきプロセス 1 つで運用する | 本モック固有 | 本物は口座状態を取引所側が単一に持つ | はい（ロックを足さない判断。書き込みロックを入れてもプロセスごとにメモリ上の状態と採番が分かれる以上、注文の消失と id 重複は防げないため、運用の制約として書くことを選んだ） | 実験は 1 プロセスで走らせる。並列度が要るときは `BITBANK_MOCK_STATE_PATH` をシナリオごとに分ける |
| 壊れた状態ファイル | fail-closed。不正な JSON・スキーマ違反・途中で切れたファイル・空ファイルはいずれも `loadState` が失敗を返し、`loadOrInitDefault` が throw して起動しない。黙って初期状態へ戻さず、壊れたファイルも消さない。ファイルが存在しないときだけ初期状態で始める | 本モック固有 | 本物には対応する概念がない | はい | 「残高が初期値に戻っている」状態でシナリオが進むことはない。起動しなかったこと自体を state 破損の合図として扱える |
| 不変量を破る状態ファイル | fail-closed。zod スキーマは通るが「状態の不変量」を破る v3 の状態ファイル（`executedAmount > startAmount`、負の残高など）は、`loadState` が移行の直後に `invariantViolations()` を走らせて失敗を返し、`loadOrInitDefault` が throw して起動しない。失敗のメッセージには違反した不変量の番号と、対象を特定する識別子と値をそのまま載せる（不変量 1〜3・5 は注文 ID、注文の無い trade は trade ID、不変量 6 は資産キー `balance[<asset>]` / `locked[<asset>]`）（例: `paper state violates invariants: 6 violation(s): 1: order 1 executedAmount=0.005 startAmount=0.001; ...`）。状態は自動修復せず、ファイルも消さない。**v1 / v2 から移行した結果が破っている場合は warn を出して起動する**（下の「不変量をどこで担保するか」を参照） | 本モック固有 | 本物には対応する概念がない | はい | 負の `remaining_amount` や負の `free_amount` が Reconcile 経路へ出ない。ただし保証の範囲は 6 本すべてではない。warn なしで起動した v3 の state について読み込み時に検査済みなのは不変量 1〜3・5・6 で、不変量 4 は単一の状態からは判定できないため検査していない（遷移関数のガードとテストで担保）。移行の warn が出た state は違反したまま起動しているので、この検査済みの保証は付かない |
| 状態の移行の冪等性 | v1 / v2 の状態ファイルを v3 へ移行する変換は決定的で、移行後の v3 を書き戻してもう一度読んでも結果は変わらない | 本モック固有 | 本物には対応する概念がない | いいえ | 旧 state から始めたシナリオでも、再起動のたびに注文・trade が動くことはない |
| private stream | Phase 5 で PubNub ではなく素の WebSocket を提供する予定 | private stream docs のメッセージ形 | 接続・配信トランスポートが異なる | はい | Nyx 側は PubNub SDK ではなく WebSocket 接続層を使う |
| private stream の順序 | 配信順序・重複なしを保証しない | private stream docs に順序保証の記載なし | Plan A では障害注入は提供しない | はい | DCL は順不同・重複を許容して状態を解釈する |

## 状態の不変量（PaperState v3）

6 本の不変量は Nyx 仕様書 D1 の前提になる。うち単一の状態から判定できる 1〜3・5・6 の述語は `src/engine/invariants.ts` の `invariantViolations()` が定義する。不変量 4 は 2 つの状態を比べる性質なので `invariantViolations()` の対象外である（担保は次節）。

### 不変量をどこで担保するか

担保は 3 層ある。**成り立たせているのは遷移関数**（`src/engine/transitions.ts`）で、`invariantViolations()` は
それを**検査する**側である。検査が走る場所は次の 2 つだけで、通常の発注・約定・取消のあとには走らない。

| 層 | 場所 | いつ走るか |
| --- | --- | --- |
| 生成 | `src/engine/transitions.ts`（`placeOrder` / `fillOrder` / `cancelOrder` / `rejectOrder`）と `src/engine/match.ts` | 常時。状態を変える唯一の経路 |
| 読み込み時の検査 | `src/engine/persist.ts` の `loadState()` | 起動時に状態ファイルを読み、v3 へ移行した直後に 1 回。違反があれば起動しない（v1 / v2 からの移行だけは warn で通す） |
| テスト | `tests/engine/invariants.test.ts` | `npm test`。fast-check のランダム操作列 40 本 × 各操作の後 |

6 本それぞれの担保箇所は次のとおり。「実行時」は本番経路（`src/`）で検査していることを指す。

| # | 不変量 | 生成（常に保つ側） | 実行時の検査 | テスト |
| --- | --- | --- | --- | --- |
| 1 | `0 <= executedAmount <= startAmount` | `fillOrder` が残量超過を `INVALID_AMOUNT` で断り、残量との差が `1e-12` 以下なら `startAmount` にクランプする。`POST /_control/orders/:id/fill` も残量超過を 400 で断る | 読み込み時のみ | あり（ランダム操作列 + 明示ケース） |
| 2 | `status ∈ {INACTIVE, UNFILLED}` ⇔ `executedAmount == 0` かつ非終端。`CANCELED_UNFILLED` / `REJECTED` も 0、`CANCELED_PARTIALLY_FILLED` は `> 0` | `cancelOrder` が現在の status（`PARTIALLY_FILLED` かどうか）で `CANCELED_PARTIALLY_FILLED` / `CANCELED_UNFILLED` を選び、`rejectOrder` は `UNFILLED` / `INACTIVE` にしか許さない | 読み込み時のみ | あり |
| 3 | `status == FULLY_FILLED` ⇔ `executedAmount == startAmount`（`startAmount > 0`） | `fillOrder` が残量 0 になった注文だけを `FULLY_FILLED` にする | 読み込み時のみ | あり |
| 4 | 終端状態のレコードは以後の遷移で変化しない | `fillOrder` / `cancelOrder` / `rejectOrder` が非 active な注文を `ORDER_NOT_ACTIVE` で断る。`POST /_control/orders/:id/fill` も終端は 409。終端になったレコードを書き換える経路は無い | **無し**（単一状態の述語ではないので `invariantViolations()` は検査できない。読み込み時にも検査されない） | あり。`tests/engine/invariants.test.ts` の「hold after random place/fill/cancel/reject sequences」が終端レコードを `JSON.stringify` で控え、各操作の後と操作列の最後に一致を見る（2 状態の比較なのでここでしか検査できない） |
| 5 | 各注文で `trades` の `amount` 合計 == `executedAmount`、`amount × price` 合計 == `executedNotional`。孤児 trade は禁止 | `fillOrder` が注文の更新と trade の追加を同じ返り値で行う（部分適用が起きない） | 読み込み時のみ（合計の一致は許容差つきで判定。下記） | あり |
| 6 | 各資産で残高は負にならず、`locked` は残高を超えない | `placeOrder` が `availableOf`（残高 − 拘束）を見て足りなければ `60001` で断る。約定は発注時に拘束した分を超えて使わない（指値の約定価格は order price より不利にならない）ので、`fillOrder` の残高更新で負にはならない。`POST /_control/reset` は負の残高・非有限の残高・`[a-z0-9]+` でない資産キーを 400 `INVALID_BALANCES` で断る | 読み込み時のみ | あり |

不変量 4 以外は単一の状態から判定できるので、`loadState()` が読み込み時に 1 回検査する。
不変量 4 は「前の状態と比べて変わっていない」という 2 状態の性質なので、`invariantViolations()` の
対象外であり、遷移関数のガードと上記のプロパティテストだけが担保である。

**移行してきた状態は fail-closed にしない。** 読み込み時の検査で起動を止めるのは、ファイルが
もともと v3 だったときだけである。v1 / v2 から移行した結果が不変量を破っている場合は
`migrated paper state violates invariants: ...` を warn に出して起動する。移行の入力は本モックが
書いたとは限らず（手で書かれた state・別実装が書いた state）、ここで落とすと旧 state の利用者が
起動できなくなるため。ただし移行後の状態が v3 として書き戻された後は、次の起動で通常の
fail-closed にかかる。なお、v2 のエンジン自身は発注時に `availableOf` を見ていたので、
v2 が書いた state が不変量 6 を破ることはない（境界の実測は PR の報告を参照）。

**資産キー・ペア名で引く地図は継承値を返さない。** 資産名とペア名は state ファイルや
リクエスト由来なので、`constructor` のように `Object.prototype` が持つ名前で引かれ得る。
素の `{}` に `map[key] ?? 既定` で引くと、キーが無いときに継承値（関数）が返って
`?? 既定` が素通りする。該当する経路（`computeLocked()` / `availableOf()` /
`invariantViolations()` の不変量 6 / `fillOrder()` の残高更新 / `GET /v1/user/assets` の
`amount_precision` / `precisionOf()`）は自分のキーだけを読む（`Object.hasOwn`、
`src/engine/state.ts` の `amountOf()`）。資産名が入る経路はペアのセグメント（`[a-z0-9]+`）と
`POST /_control/reset` の `balances` のキーで、後者も同じ文字種に限るので、この経路で当たる
資産名は `constructor` だけである（control 側の検査を外すと、空文字や改行を含む資産名が
`GET /v1/user/assets` の `asset` と状態ファイルへ入る）。

書き込み後（発注・取消・`/_control/` の fill / tick / reset の直後）の検査は入れていない。
`invariantViolations()` は注文ごとに `state.trades` を `filter` するので費用が注文数 × 約定数に比例し、
注文 1,000 件・約定 1,000 件で 1 回 11〜13 ms（`POST /_control/orders/:id/fill` の応答が 7.3 ms → 22.1 ms、約 3 倍）、
5,000 件 × 5,000 件で約 250 ms かかる。読み込み時は起動 1 回だけなので、この費用を払っている。

### 6 本の不変量

1. `0 <= executedAmount <= startAmount`
2. `status ∈ {INACTIVE, UNFILLED}` ⇔ `executedAmount == 0` かつ非終端（`INACTIVE` は Plan A では到達しない）。`CANCELED_UNFILLED` / `REJECTED` も `executedAmount == 0`。`CANCELED_PARTIALLY_FILLED` は `executedAmount > 0`
3. `status == FULLY_FILLED` ⇔ `executedAmount == startAmount`（`startAmount > 0`）
4. 終端状態（`FULLY_FILLED` / `CANCELED_*` / `REJECTED`）のレコードは以後の遷移で変化しない
5. 各注文について、`trades` の `amount` 合計 == `executedAmount`、かつ `amount × price` 合計 == `executedNotional`。`orderId` が注文に存在しない trade は禁止（`invariantViolations()` の判定は倍精度の丸め誤差を吸収する許容差つきで、`amount` の合計は `1e-12`、`amount × price` の合計は `1e-6` を超える差だけを違反とする。等式そのものは緩めていない）
6. 各資産で残高は負にならず、`locked` は残高を超えない（`availableOf >= 0`。買いの拘束額は手数料込み）

そのほか Phase 1 で決めた内部規則:

- ペアは `base_quote` の 2 セグメントだけを受け付ける。余剰セグメント（`btc_jpy_x`）と base == quote（`jpy_jpy`）は `INVALID_PAIR`。加えて各セグメントの文字種を `[a-z0-9]+` に限り、記号・空白・制御文字・大文字を含むペア（`../../admin_jpy` / `btc?a=1_jpy` / `btc#frag_jpy`）も `INVALID_PAIR`。不正ペアの発注は `tick()` より前に拒否し、他注文を動かさない
  - **公式の根拠**: pairs.md（コミット `0badd680`）に載るペア記号は 62 個で、すべて「英小文字のみのセグメント」2 つを `_` で繋いだ形。数字も記号も含まない
  - **数字を許した理由（公式より緩い上限。推測）**: 公式が英小文字だけでも `[a-z]` に絞ると、bitbank が数字を含むペアを足したときに弾いてしまう。この制約の目的は記号を落とすことなので、数字は残した保守的な上限にした
  - **ホワイトリストにはしない**: 公式一覧に無くても形が正しいペア（`foo_jpy`）はこれまでどおり受け付ける。「数量・価格の精度」行の「未登録ペアも同じ桁を仮置きする」を保つため。直したのは**文字種**であって**ペアの実在性**ではない（本物は未知のペアに `10000` を返すので実在性の検査には揃える価値があるが、挙動変更になるのでここでは決めていない）
  - **文字種を弾く理由**: pair は外向きの足取得 URL のパスへ入る（`src/engine/candles.ts` の `fetchOneDay`）。`..` はベース URL のパス接頭辞を脱出し、`?` / `#` は以降をクエリ・フラグメントに変える。入口（`pairAssets`）と URL 組み立て（`encodeURIComponent` で 1 パスセグメントに閉じ込める）の 2 層で守る
  - **状態ファイル由来の不正なペア**: `PaperStateSchema` は pair の文字種を検証しないので、この規則より前に書かれた注文はそのまま読み込まれる（起動は落ちず、その注文も消えない）。`SessionStore.tick()` はそのペアを外向きに問い合わせずに読み飛ばし、`POST /_control/tick` は 400 `INVALID_PAIR` で弾く。`cancel_order` は今までどおり通るので、取り除く手段は残る
- `fillOrder` は残量との差が `1e-12` 以下なら全量約定として残量にクランプし、`executedAmount` を `startAmount` に揃える（倍精度の塵で終端に届かないことを防ぐ。Phase 2 の桁数量子化が主防御）
- `rejectOrder` は `UNFILLED` / `INACTIVE`（`executedAmount == 0`）にだけ許す。部分約定済みは `CANCELED_PARTIALLY_FILLED` へ取消する
