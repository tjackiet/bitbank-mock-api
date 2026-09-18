# bitbank-lab-mock

[![CI](https://github.com/tjackiet/bitbank-mock-api/actions/workflows/ci.yml/badge.svg)](https://github.com/tjackiet/bitbank-mock-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

挙動確認・検証目的で作成している、bitbank Private REST API モック。注文の状態を持つ挙動確認用であり、**bitbank 公式のテスト環境ではない**。

旧リポジトリ名は `bitbank-mock-api`。

## はじめにお読みください

- 本ツールは**開発段階（ベータ版）**です。利用は**自己責任**でお願いします。
- ご利用の前に必ず [⚠️ 免責事項](#免責事項) をお読みください。
- 本リポジトリは **bitbank バグバウンティプログラムの対象範囲外** です。
- 公開ドキュメントに準拠した**近似**であり、動作保証はしません。本物との差分は [`docs/fidelity.md`](docs/fidelity.md) を正とします。

## これは何

Plan A（v0.1.0）で実装しているのは次の 3 つです。

- **R3** 注文レコード（`OrderRecord`）を単一の真実とする状態モデル
- **R1** `GET /v1/user/spot/order` と `POST /v1/user/spot/orders_info` による照会
- **R2** 実験用の `/_control/`（市場に依存せず約定を起こす）

注文状態の照合（リコンサイル）は `orders_info` を主経路にします。private stream（R4）は未実装です。

## `mock-bitbankcc` との棲み分け

| | 本リポジトリ | [`bitbankinc/mock-bitbankcc`](https://github.com/bitbankinc/mock-bitbankcc) |
| --- | --- | --- |
| 用途 | 注文状態を持つ挙動確認・検証 | SDK テスト用の静的スタブ |
| 実装 | 仮想残高・約定・永続化 | WireMock の固定レスポンス |
| 公式テスト環境か | いいえ | いいえ |

## 起動

Node.js 20 以上。

```bash
git clone https://github.com/tjackiet/bitbank-mock-api.git
cd bitbank-mock-api
npm ci
BITBANK_MOCK_CONTROL=1 npm run dev
```

既定は `http://127.0.0.1:14000`（control 有効時。無効時は `0.0.0.0:14000`）。ポートは `--port` または `BITBANK_MOCK_PORT`。

再現シナリオ（発注 → 拘束 → control fill → 残高減）:

```bash
BITBANK_MOCK_CONTROL=1 npm run dev
# 別端末
./examples/scenario-plan-a.sh
```

`curl` だけで動きます（JSON の取り出しは `sed` / `grep`）。**何度流しても同じ値が出るよう、先頭で `POST /_control/reset` を叩いて状態を捨てます。** 取っておきたいシナリオがあるときは `BITBANK_MOCK_STATE_PATH` を分けてください。

## 環境変数

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `BITBANK_MOCK_CONTROL` | 未設定（control 無効） | `1` のとき `/_control/` を登録する |
| `BITBANK_MOCK_FILL_MODE` | control 有効時 `manual`、無効時 `market` | `manual` では REST の `tick()` が市場足を取りに行かない |
| `BITBANK_MOCK_HOST` | control 有効時 `127.0.0.1`、無効時 `0.0.0.0` | listen アドレス |
| `BITBANK_MOCK_PORT` | `14000` | listen ポート |
| `BITBANK_MOCK_CONTROL_TOKEN` | 未設定 | 非ループバックからの `/_control/` に必要な `X-Control-Token` |
| `BITBANK_MOCK_PERSIST_FAILURE` | `degrade` | 状態ファイルへの書き出しに失敗した後の挙動。`degrade` は状態を変える要求を断り読み取りは生かす。`ignore` は v0.1.0 の挙動（何も断らない） |
| `BITBANK_MOCK_STATE_PATH` | `~/.bitbank-mock/sessions/default/state.json` | 状態ファイルのパス |
| `BITBANK_MOCK_HOME` | `~/.bitbank-mock` | `STATE_PATH` 未指定時のルート |
| `BITBANK_PUBLIC_BASE_URL` | `https://public.bitbank.cc` | 足を取りに行く公開 API のベース URL（`BITBANK_MOCK_FILL_MODE=market` のときだけ使う） |

状態ファイルは起動時に検査します。JSON が壊れている・スキーマに合わない場合に加えて、[`docs/fidelity.md`](docs/fidelity.md) の「状態の不変量（PaperState v3）」のうち単一の状態から判定できるもの（不変量 1〜3・5・6）を破っている場合も**起動しません**（自動修復も初期化もしません。ファイルはそのまま残します）。エラーには破れた不変量の番号と、その対象を特定する識別子が出ます（不変量 1〜3・5 は注文 ID、注文の無い trade は trade ID、不変量 6 は資産キー）。

```
Error: paper state violates invariants: 6 violation(s): 1: order 1 executedAmount=0.005 startAmount=0.001; 2: order 1 status=UNFILLED executedAmount=0.005; 5: order 1 trades=0 executedAmount=0.005; 5: order 1 tradeNotional=0 executedNotional=25000; 6: balance[jpy]=-500000 is negative; 6: locked[jpy]=-20024 exceeds balance=-500000
```

v1 / v2 の状態ファイルを v3 へ移行した結果が不変量を破っている場合だけは、起動を止めずに warn を出します（`migrated paper state violates invariants: ...`）。

**書き出しに一度でも失敗すると、以後は状態を変える要求を断ります**（v0.1.0 からの変更）。発注・取消・`/_control/` の fill / tick / clock / reset は断り、照会（`GET order` / `orders_info` / `active_orders` / `trade_history` / `assets` / `GET /_control/state`）は今までどおり通します。失敗したシナリオを読み出せるようにするためです。断り方は互換ルートが封筒の `70001`、`/_control/` が 503 `PERSIST_DEGRADED` です。

**復帰は再起動です。** ディスクを直す → `GET /_control/state` でシナリオを読み出す → 再起動、の順で進めてください。劣化中は市場モードの自動約定も止まります（読むたびにメモリだけ進んで状態ファイルとの差が開くのを避けるため）。

書き込みが効いているかは `GET /_control/state` の `persist` で確かめられます（`consecutiveFailures > 0` なら今まさに失敗しています。`lastError` は成功しても消えないので、一度でも失敗したかが残ります）。v0.1.0 の挙動に戻すには `BITBANK_MOCK_PERSIST_FAILURE=ignore` を設定してください。

**同じ状態ファイルを 2 プロセスから使うことはできません。** 起動時に `<状態ファイル>.lock` を取り、既に生きているプロセスが持っていれば起動しません（黙って壊れるのではなく、弾きます）。並列にシナリオを流すときは `BITBANK_MOCK_STATE_PATH` をシナリオごとに分けてください。

`SIGKILL` などでロックが残った場合は、次の起動が保持プロセスの生死を見て奪うので手で消す必要はありません。**ロックは二重起動を弾くためのもので、競合を防ぎ切るものではありません**（2 プロセスが同じ残存ロックを同時に奪いに行く窓が残っています）。詳しくは [`docs/fidelity.md`](docs/fidelity.md) の「同一状態ファイルの多重起動」の行を見てください。

## `/_control/`

bitbank API には存在しません。本番クライアントから叩かないでください。応答は bitbank 封筒ではなく素の JSON です。

| メソッド | パス | 動作 |
| --- | --- | --- |
| `POST` | `/_control/orders/:order_id/fill` | 指定注文を約定。`amount` 省略は残量全部、`price` 省略は指値 |
| `POST` | `/_control/tick` | `{ pair, price }` または `{ pair, candle }` で人工の足を 1 本適用 |
| `POST` | `/_control/clock` | `lastTickAt` だけを動かす。本文省略で現在時刻、`{ lastTickAt }` に ISO 文字列かエポックミリ秒。注文・約定・残高は残る |
| `POST` | `/_control/reset` | 状態を初期化 |
| `GET` | `/_control/state` | `PaperState` に、状態ファイルへの書き出しの状況（`persist`）を添えて返す |

`POST /_control/tick` が進める `lastTickAt`（control の時計）は、足の `timestamp` でも tick ごとの 60 秒の前進でも、実時刻より先へは 24 時間までしか動きません。超える要求は 400（`CANDLE_TOO_FAR_AHEAD` / `CLOCK_TOO_FAR_AHEAD`）で断り、状態は変えません。戻すのは `POST /_control/clock` です（`reset` と違って注文・約定・残高は残ります）。詳細は [`docs/fidelity.md`](docs/fidelity.md) の「control の時計」の行にあります。

無効時は 404。非ループバックはトークンが一致しない限り 403 です。状態ファイルへの書き出しに失敗した後は、状態を変える口（`fill` / `tick` / `clock` / `reset`）が 503 `PERSIST_DEGRADED` になります（`GET /_control/state` は通ります）。**ループバックからはトークン無しで通る**ので、同一ホスト上の他プロセスからの誤操作は防げません。接続元の判定には TCP の対向アドレスだけを使い、`X-Forwarded-For` は見ません（Fastify の `trustProxy` の設定に境界は左右されません。ただし判定を `request.ip` に変えると、`trustProxy` を有効にした瞬間にヘッダの詐称で迂回できるようになります）。`X-Control-Token` はヘッダ行がちょうど 1 本のときだけ受け付けます。

## 非目標（Plan A）

- 公式 testnet / 動作保証 / 全 error code の網羅
- 認証ヘッダの検証、レート制限、注文訂正
- ダッシュボード、public REST の網羅、private stream（Phase 5）
- 障害注入（重複・順序入替）

計画の詳細は [`docs/plan-lab-mock.md`](docs/plan-lab-mock.md) です。

## 開発

```bash
npm test
npm run typecheck
```

## 免責事項

構成は [bitbank-lab-cli の免責事項](https://github.com/bitbankinc/bitbank-lab-cli#免責事項) に合わせ、本モック向けに文言を置いています。

### 開発段階について

本ツールは開発段階（ベータ版）です。バグ、不具合、誤動作、または公開ドキュメントと異なる応答を含む可能性があります。bitbank 公式のテスト環境ではなく、互換性や継続提供を保証するものではありません。

### AI エージェントによる処理結果について

本モックサーバが提供するデータを AI エージェント等が処理・生成した結果について、正確性、完全性、有用性、最新性を保証するものではありません。AI エージェント等による処理の結果、注文種別、価格、数量その他の取引条件が利用者の意図と異なる形で処理または実行される可能性があります。

### 金融商品取引法上の位置づけ

本ツールは情報提供および挙動確認・検証のみを目的として提供されるものであり、投資助言・代理業、投資勧誘、その他金融商品取引法上の行為を目的とするものではありません。

### 外部サービスへの依拠

本ツールは外部 API、LLM、第三者サービス等に依拠して提供するものであり、これらの仕様変更、停止、不具合等が生じた場合には、本ツールが正常に動作しない可能性があります。`BITBANK_MOCK_FILL_MODE=market` のときは公開ローソク足を取得します。

### 安全対策の補助性

本ツールに実装されているバリデーション、`/_control/` のアクセス制限その他の安全対策は、誤操作を減らすための補助機能であり、その完全な防止を保証するものではありません。Plan A では認証ヘッダを検証しません。本物の API キーを本モックに向けないでください。

### 利用者の責任

利用者は、本ツールにより提供・生成された情報および注文内容等を自身で十分に確認の上、自己の判断と責任において本ツールを利用し、投資判断、注文実行および取引を行うものとします。本モック上の約定・残高は仮想であり、bitbank 本番口座には反映されません。

### 損害の免責

当社は、本ツールの利用もしくは利用不能、または本ツールにより提供・生成された情報、AI エージェント等による処理結果もしくは取引操作に基づく投資判断・注文・取引等に関連して生じたいかなる損害についても、当社の故意または重過失による場合を除き、一切責任を負いません。

### APIキー・認証情報の管理

APIキーおよび取引に必要なパスワード等は利用者自身の責任において適切に管理してください。チャット欄や公開リポジトリその他第三者が閲覧可能な環境等へ APIキーや取引パスワード等の認証情報等を入力・掲載しないよう十分ご注意ください。

利用者による認証情報等の管理不備、誤入力、漏えい、第三者利用等により生じたいかなる損害についても、当社の故意または重過失による場合を除き、当社は一切責任を負いません。

## License

MIT
