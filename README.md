# bitbank-mock-api

bitbank.cc API 互換の mock サーバ。**bot を実弾なしで動かすためのローカル開発環境**。

## これは何

- bitbank の REST + WebSocket をローカルで模倣
- bot の `BASE_URL` を localhost に差し替えるだけで動く
- public market data（ticker / orderbook / candles）は本物の bitbank をプロキシ
- 約定・残高・PnL は仮想（ローカル state）
- ダッシュボードでローソク足・板・自分の bot の挙動を可視化

## ステータス

🚧 **WIP — まだ動きません。** 設計フェーズ。

## ロードマップ（MVP）

- [ ] 仮想 fill エンジン（`paper-trade` からの移植）
- [ ] REST 互換: `assets` / `active_orders` / `trade_history` / `create_order` / `cancel_order`
- [ ] WS public プロキシ
- [ ] WS private push（`spot_order_*` / `asset_room`）
- [ ] ダッシュボード（ローソク足 + 板 + Positions / Open orders / Equity curve）

## 関連

- 設計の前段は [`tjackiet/bitbank-cli-skills`](https://github.com/tjackiet/bitbank-cli-skills) の `paper-trade` から派生

## License

MIT
