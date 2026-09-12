# CLAUDE.md

このリポジトリで作業するセッション向けのプロジェクト規約。各セッションが規約を再発見しなくて済むよう、ここに集約する。

## プロジェクトの位置づけ

- Nyx Foundation 共同研究向けの bitbank Private REST API モック（パッケージ名 `bitbank-lab-mock`、リポジトリ名 `bitbank-mock-api`）。
- **bitbank 公式のテスト環境ではない。** 公開ドキュメントに準拠した近似であり、動作保証はしない。bitbank バグバウンティプログラムの対象範囲外。
- 本物との差分は [`docs/fidelity.md`](docs/fidelity.md) を正とする。挙動の根拠を確認するときは実装よりまずこの表を読む。
- 計画の詳細は [`docs/plan-lab-mock.md`](docs/plan-lab-mock.md)、設計は [`docs/design.md`](docs/design.md)。

## コマンド

| コマンド | 実行内容 |
| --- | --- |
| `npm test` | `vitest run`（`tests/` 以下を 1 回実行） |
| `npm run typecheck` | `tsc --noEmit`（`src/**/*` と `tests/**/*` を型検査） |
| `npm run dev` | `tsx src/index.ts`（サーバを起動。既定 `http://127.0.0.1:14000`。`/_control/` を使うなら `BITBANK_MOCK_CONTROL=1`） |

**lint と formatter は設定されていない。** ESLint / Prettier / Biome いずれの設定ファイルも依存もない。整形は既存コードのスタイルに合わせて手で揃える。

環境変数の一覧は [`README.md`](README.md) の「環境変数」節にある。

## 必須の規約

- **公式ドキュメントに明記されない挙動を決めたら、実装と同じ PR で `docs/fidelity.md` に追記する。** [`.github/pull_request_template.md`](.github/pull_request_template.md) のチェックリスト項目であり、共同研究の前提条件書としての `docs/fidelity.md` の役割そのもの。
- **`npm test` と `npm run typecheck` を green にしてから PR を出す。** これも PR テンプレートのチェックリストにある。
- CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）は **Node 24** で `npm ci` → `npm run typecheck` → `npm test` を走らせる。`package.json` の `engines.node` は `>=20` なので、ローカルが 20 系でも CI は 24 で通る必要がある。

## コードの約束

- **ESM**（`package.json` の `"type": "module"`）。**相対 import は拡張子 `.ts` を明示する**（`tsconfig.json` の `allowImportingTsExtensions: true`）。例: `import { ok } from "./envelope.ts";`
- `tsconfig.json` は `strict: true` / `noEmit: true` / `moduleResolution: "Bundler"` / `target: "ES2022"`。
- **`src/` と `tests/` はディレクトリ構成を対応させる。** `src/engine/match.ts` のテストは `tests/engine/match.test.ts`。`tests/` には固有のディレクトリとして `fixtures/`（テストデータ）と `scenarios/`（結合シナリオ）がある。
- **bitbank 互換ルートは [`src/routes/envelope.ts`](src/routes/envelope.ts) の `ok()` / `err()` で bitbank 封筒に包む。** 成功は `{ success: 1, data }`、失敗は `{ success: 0, data: { code } }`。エラーは同ファイルの `ErrorCode` にある bitbank の error code を返す（例: 残高不足 `60001`、注文が見つからない `50009`）。
- 互換ルートのパスは `/v1/user/...`（`src/routes/` の各ファイル）。登録は [`src/server/http.ts`](src/server/http.ts) の `buildServer()`。
- **`/_control/` は bitbank API に存在しない実験用の口で、素の JSON を返す。** 封筒には包まず、HTTP ステータス（400 / 403 / 404 / 409）で失敗を表す。実装は [`src/routes/control.ts`](src/routes/control.ts)。`BITBANK_MOCK_CONTROL=1` のときだけ登録され、非ループバックからは `X-Control-Token` の一致を要求する。
- **注文の単一の真実は [`src/engine/state.ts`](src/engine/state.ts) の `OrderRecord`。** 注文状態・約定量・約定代金はここに集約する。状態全体は `PaperState`（zod スキーマ、`version: 3`）。
- **[`src/engine/invariants.ts`](src/engine/invariants.ts) の不変量は常に保つ**（`executedAmount` の範囲、status と約定量の整合、trade 合計と `executedAmount` / `executedNotional` の一致、残高が負にならない、拘束量が残高を超えない）。**状態を変える変更を入れたら `tests/engine/invariants.test.ts` も確認する**（fast-check によるランダム操作列のプロパティテスト）。
- **コメントとドキュメントは日本語**で書く。

## 作業のしかた

- **`main` へ直接 push しない。** 指定されたブランチで作業する。
- **PR は明示的に指示されたときだけ作る。**
