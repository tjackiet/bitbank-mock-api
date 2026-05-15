# bitbank-mock-api 設計（MVP）

## このドキュメントの目的

bitbank-mock-api の MVP リリースまでの設計合議を残す。実装開始時にこのドキュメントを起点にする。

## 立ち位置

- **ローカル mock サーバ**。bitbank 社の公式 testnet ではない
- bitbank.cc の REST + WebSocket と互換のプロトコルを話す
- bot 側の変更は **BASE_URL の差し替えのみ** で動くことを最重要 KPI とする
- public market data（ticker / orderbook / candles / transactions）は本物の bitbank API をプロキシ
- 約定・残高・PnL はローカル状態（仮想 fill）

## なぜ作るか

bitbank.cc にはテスト環境（test API key 発行 / sandbox）が存在しない。
bot 開発者は実弾でしか動作確認できず、開発体験・勉強会開催の障壁になっている。
公式が用意するのは現実的でないため、コミュニティ側で代替を作る。

## 想定ユーザー

- bitbank で bot を運用 / 開発する個人 botter
- 海外 CEX から bitbank に乗り換え検討中の bot 開発者
- bitbank bot 勉強会の主催者・参加者

## 利用フロー

```
1. インストール & 起動
   $ npx bitbank-mock serve --port 14000

2. bot 側で BASE_URL を切替
   BITBANK_REST_URL=http://localhost:14000
   BITBANK_WS_URL=ws://localhost:14000
   ACCESS-KEY=test
   ACCESS-SECRET=test

3. bot をいつも通り起動

4. ブラウザで http://localhost:14000 を開いて挙動を可視化
```

## ダッシュボード構成

3 ペイン構成:

```
┌──────────────────────┬──────────┬─────────────────────┐
│ ローソク足           │ 板       │ Positions           │
│  + 約定マーク (▲▼)   │ (チカチカ)│ Open orders         │
│                      │          │ Equity curve        │
└──────────────────────┴──────────┴─────────────────────┘
   メイン                細い縦長    bot ビュー
```

- **左**: ローソク足チャート（1m / 5m / 15m / 1h 切替可）
  - 自 bot の約定を ▲▼ で重畳（buy = 緑▲ / sell = 赤▼）
  - 出来高をサブパネルに
  - 注文失敗マーク（×）は余力次第
- **中央**: 市場の orderbook ladder（細い縦長、bitbank web UI と同比率）
- **右**: bot 自身のリアルタイム状態
  - Positions（建玉 / JPY 残高）
  - Open orders（未約定指値）
  - Equity curve（PnL 推移 + drawdown はこのカーブから読む）

ローソク足の x 軸 = mock の lazy tick タイミング（paper-trade の 1m candle fill 判定と同思想）。

## MVP スコープ（P0）

### REST 互換

- POST /v1/user/spot/order （create-order: market / limit GTC のみ）
- POST /v1/user/spot/cancel_order
- POST /v1/user/spot/cancel_orders
- GET  /v1/user/assets
- GET  /v1/user/spot/active_orders
- GET  /v1/user/spot/trade_history

レスポンス封筒は bitbank 形式: `{ success: 1, data: ... }` / `{ success: 0, data: { code: ... } }`

### WebSocket

- **public channels** （transactions / depth / ticker / candlestick）を本物の bitbank からプロキシ
- **private push** （spot_order_* / asset_room）を mock 内部状態から生成
- プロトコルは bitbank と同じ socket.io v2 互換

### 認証

- ACCESS-KEY / ACCESS-SIGNATURE / ACCESS-NONCE ヘッダの **存在チェックのみ**
- 固定値 `test` / `test` を docs に明記、bot から既存 HMAC コードのまま叩ける
- HMAC 厳密検証は P1

### ダッシュボード

- 3 ペイン構成（上記）
- bitbank-cli-skills 側で書いた orderbook HTML を流用
- ローソク足は lightweight-charts または Chart.js

## スコープ外 / P1 以降

- stop / stop_limit / IOC / FOK 注文
- 部分約定
- HMAC 厳密検証
- withdraw / deposit endpoint
- margin / leverage
- bitbank 公称エラーコードの完全網羅
- セッション replay
- シナリオ注入（latency / forced error）
- 複数 bot 同居（複数 API key）

## アーキテクチャ概要

```
bitbank-mock-api/
├─ src/
│  ├─ index.ts                  # エントリ: bitbank-mock serve
│  ├─ server/
│  │  ├─ http.ts                # Fastify セットアップ
│  │  ├─ ws.ts                  # socket.io サーバ
│  │  ├─ auth.ts                # ヘッダ存在チェック
│  │  └─ trace.ts               # req/res を trace.jsonl に書く
│  ├─ routes/                   # bitbank REST 互換ルート
│  │  ├─ assets.ts
│  │  ├─ active-orders.ts
│  │  ├─ trade-history.ts
│  │  ├─ create-order.ts
│  │  ├─ cancel-order.ts
│  │  └─ envelope.ts            # success:1/0 への変換
│  ├─ channels/                 # WS
│  │  ├─ public-proxy.ts        # 本物の bitbank public WS をプロキシ
│  │  ├─ asset-room.ts
│  │  └─ spot-order.ts
│  ├─ engine/                   # paper-trade からの移植
│  │  ├─ state.ts
│  │  ├─ match.ts               # 成行 / 指値 GTC の fill 判定
│  │  ├─ candles.ts
│  │  └─ persist.ts             # ~/.bitbank-mock/sessions/<id>/state.json
│  ├─ schemas/                  # Zod
│  │  ├─ requests.ts
│  │  ├─ responses.ts
│  │  └─ errors.ts
│  └─ dashboard/                # 静的フロント
├─ tests/
│  └─ fixtures/                 # 本物 bitbank レスポンスのゴールデン
└─ examples/                    # サンプル bot
   ├─ python-bot.py
   └─ node-bot.ts
```

### 依存（最小）

- fastify
- @fastify/websocket または socket.io
- zod
- undici（bitbank public API fetch 用）

### 状態の永続化

- `~/.bitbank-mock/sessions/<session-id>/state.json` ... 残高・open orders・履歴
- `~/.bitbank-mock/sessions/<session-id>/trace.jsonl` ... 全 req/res + emit したい push（replay 用、P1）

## エンジンの扱い

- 最初は bitbank-cli-skills の `cli/commands/paper/` を **コピー移植**
- MVP が動いた後、共通部分を `bitbank-paper-engine` として shared package に切り出す
- 早すぎる抽象化を避ける

## 開発フェーズ

| Phase | 内容 |
|---|---|
| 0 | scaffold ✅（このコミットの前段で完了） |
| 1 | engine 移植（state / match / candles） |
| 2 | REST 5 endpoint + envelope |
| 3 | auth middleware（ヘッダ存在チェック） |
| 4 | WS public proxy |
| 5 | WS private push |
| 6 | ダッシュボード（3 ペイン） |
| 7 | examples（python / node） |
| 8 | MVP リリース → 知人 botter にフィードバック依頼 |

## 関連リポジトリ

- [tjackiet/bitbank-cli-skills](https://github.com/tjackiet/bitbank-cli-skills) — bitbank API への CLI アクセス層。`paper-trade` 機能がこの mock の前段
- [bitbankinc/bitbank-api-docs](https://github.com/bitbankinc/bitbank-api-docs) — bitbank 公式の REST / WebSocket API 仕様。互換実装の参照元
