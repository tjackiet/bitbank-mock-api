# CLAUDE.md

このリポジトリで作業するセッション向けのプロジェクト規約。各セッションが規約を再発見しなくて済むよう、ここに集約する。

## プロジェクトの位置づけ

- 挙動確認・検証目的で作成している bitbank Private REST API モック（パッケージ名 `bitbank-lab-mock`、リポジトリ名 `bitbank-mock-api`）。
- **bitbank 公式のテスト環境ではない。** 公開ドキュメントに準拠した近似であり、動作保証はしない。bitbank バグバウンティプログラムの対象範囲外。
- 本物との差分は [`docs/fidelity.md`](docs/fidelity.md) を正とする。挙動の根拠を確認するときは実装よりまずこの表を読む。
- 計画と設計判断は [`docs/plan-lab-mock.md`](docs/plan-lab-mock.md)。[`docs/design.md`](docs/design.md) は Plan A 以前の MVP 設計メモ（**履歴**）で、実装と食い違う箇所がある（冒頭の注記に一覧）。根拠には使わない。

## コマンド

| コマンド | 実行内容 |
| --- | --- |
| `npm test` | `vitest run`（`tests/` 以下を 1 回実行） |
| `npm run typecheck` | `tsc --noEmit`（`src/**/*` と `tests/**/*` を型検査） |
| `npm run dev` | `tsx src/index.ts`（サーバを起動。listen は control 有効時 `127.0.0.1:14000`、**control 無効時は `0.0.0.0:14000`**。`/_control/` を使うなら `BITBANK_MOCK_CONTROL=1`。ポートは `BITBANK_MOCK_PORT` か `serve --port`。**`--port` 単独は `unknown command` で落ちる**） |

**lint と formatter は設定されていない。** ESLint / Prettier / Biome いずれの設定ファイルも依存もない。整形は既存コードのスタイルに合わせて手で揃える。

環境変数の一覧は [`README.md`](README.md) の「環境変数」節にある。

## 必須の規約

- **公式ドキュメントに明記されない挙動を決めたら、実装と同じ PR で `docs/fidelity.md` に追記する。** [`.github/pull_request_template.md`](.github/pull_request_template.md) のチェックリスト項目であり、挙動の前提を記録するという `docs/fidelity.md` の役割そのもの。
- **`npm test` と `npm run typecheck` を green にしてから PR を出す。** これも PR テンプレートのチェックリストにある。
- CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）は **Node 24** で `npm ci` → `npm run typecheck` → `npm test` を走らせる。`package.json` の `engines.node` は `>=20` なので、ローカルが 20 系でも CI は 24 で通る必要がある。
- **PR ではもう 1 本、[`.github/workflows/security.yml`](.github/workflows/security.yml) も走る。**`npm audit --audit-level=high`（high 以上の脆弱性で落ちる）と gitleaks（git 全履歴の秘密情報スキャン）の 2 ジョブ。CI が green でもこちらが赤いことがある。

## コードの約束

- **ESM**（`package.json` の `"type": "module"`）。**相対 import は拡張子 `.ts` を明示する**。例: `import { ok } from "./envelope.ts";` 落とすと `npm run typecheck` が `TS2835` で落ちる（`moduleResolution: "NodeNext"` + `allowImportingTsExtensions: true`）。
- `tsconfig.json` は `strict: true` / `noEmit: true` / `module` と `moduleResolution` が `"NodeNext"` / `target: "ES2022"`。
- **`src/` と `tests/` はディレクトリ構成を対応させる**（`src/engine/match.ts` → `tests/engine/match.test.ts`）。例外は `tests/structure.test.ts` が理由つきで持ち、ずれると落ちる。
- **bitbank 互換ルートは [`src/routes/envelope.ts`](src/routes/envelope.ts) の `ok()` / `err()` で bitbank 封筒に包む。** 成功は `{ success: 1, data }`、失敗は `{ success: 0, data: { code } }`。エラーは同ファイルの `ErrorCode` にある bitbank の error code を返す（例: 残高不足 `60001`、注文が見つからない `50009`）。
- 互換ルートのパスは `/v1/user/...`（`src/routes/` の各ファイル）。登録は [`src/server/http.ts`](src/server/http.ts) の `buildServer()`。
- **`/_control/` は bitbank API に存在しない実験用の口で、素の JSON を返す。** 封筒には包まず、HTTP ステータス（400 / 403 / 404 / 409。状態ファイルへの書き出しに失敗した後は、状態を変える口が 503）で失敗を表す。実装は [`src/routes/control.ts`](src/routes/control.ts)。`BITBANK_MOCK_CONTROL=1` のときだけ登録され、非ループバックからは `X-Control-Token` の一致を要求する。
- **注文の単一の真実は [`src/engine/state.ts`](src/engine/state.ts) の `OrderRecord`。** 注文状態・約定量・約定代金はここに集約する。状態全体は `PaperState`（zod スキーマ、`version: 3`）。
- **[`src/engine/invariants.ts`](src/engine/invariants.ts) の不変量は常に保つ**（`executedAmount` の範囲、status と約定量の整合、trade 合計と `executedAmount` / `executedNotional` の一致、残高が負にならない、拘束量が残高を超えない）。**状態を変える変更を入れたら `tests/engine/invariants.test.ts` も確認する**（fast-check によるランダム操作列のプロパティテスト）。
- **コメントとドキュメントは日本語**で書く。

## 作業のしかた

- **`main` へ直接 push しない。** 指定されたブランチで作業する。
- **PR は明示的に指示されたときだけ作る。**
