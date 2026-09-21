# tests/fixtures

テストが読む固定データ。**どこから来た値なのかをここに書く**——出典の無い値が
「公式の応答」として扱われると、テストが実装に同意するだけの検査になる。

## `candlestick-btc_jpy-1min.json`

公開 API `GET /{pair}/candlestick/{candle-type}/{YYYYMMDD}` の応答。
`src/engine/candles.ts` の `defaultFetchCandles()` が読む形である。

**構造の出典**: bitbank 公式ドキュメント
[`public-api.md`](https://github.com/bitbankinc/bitbank-api-docs/blob/0badd68019646171826625b074cfef4235c3e713/public-api.md)
の `### Candlestick` 節（固定コミット `0badd68`、`public-api_JP.md` も同じ内容）。

- 応答例: `public-api.md:324-346`。**`timestamp` は `candlestick` 要素の中**（`:341`）で、
  `data` 直下ではない
- フィールド表: `public-api.md:316-320`（`type` は `:318`、`ohlcv` は `:319`、
  `timestamp` は `:320` の "published at unix timestamp (milliseconds)"）
- 日付の書式: `1min` は `YYYYMMDD`（`public-api.md:310-312`）

**値そのものに出典は無い。** 公式の応答例は値がプレースホルダ（`"string"` / `0`）で、
`defaultFetchCandles()` のパーサが数値へ変換するためそのままでは使えない。そこで
**形は公式どおり、値だけ現実的な数値文字列**にしてある。

価格・数量・時刻は**このリポジトリで作った架空の値**であり、公式ドキュメントに載っている
例の値でも、実口座・実市場の観測値でもない（このリポジトリは公開されている）。
