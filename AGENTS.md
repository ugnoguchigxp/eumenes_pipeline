# AGENTS.md — Eumenes Pipeline

Muse Code はこのファイルをプロジェクト規則として読む。計画の正本は [plan.md](plan.md)、骨格の構築記録と引き継ぎは [docs/handoff/2026-11-03-skeleton.md](docs/handoff/2026-11-03-skeleton.md)。

## 目的と現在地

ツールチェーンバンドル（Eumenesに登録済みの部品）を組み合わせ、利用者の依頼を `request`・`steps`・`output` の短い定義にする。最終的に **Eumenesへtarballで取り込む**（plan §7）。

2026-11-03時点: 骨格・評価用カタログ・Eumenesから抽出した契約・モック・作業用SQLite・Museの推論口・オフライン検証は構築済み。**P0a〜P0e（棚卸しの確認、契約、比較の足場、実測、決定）とP1以降はMuseの担当。** 記述形式（JSON/YAML）、Routerの利用範囲、`src/` の定義schemaは未確定（provisional）。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `bun install` | 依存の導入（`bunfig.toml` の7日ルールに従う） |
| `bun run check:all` | 型検査（通常と配布ビルド設定）・lint・整形確認・全テスト。変更後に必ず通す |
| `bun test <file>` | 対象テストだけを実行（反復中はこちら） |
| `bun run bench:catalog` | P0a棚卸しを `data/catalog/` に再生成（決定的。差分が出たら入力が変わった証拠） |
| `bun run bench:verify` | 通信なしの配線検証。作業DBに記録。`--db :memory:` で記録なし |
| `bun run build` / `bun run pack:check` | 配布ビルド / 梱包内容の検査（書き込みなし） |
| `bun run pack` | `artifacts/<名前-版-digest>/` に tarball・`.sha256`・`manifest.json` を作る（空の利用側で導入・型・実行を検査してから。既存は上書きしない） |
| `bun run contracts:extract` | `../eumenes` からschemaを再抽出（読み取りのみ）。再抽出したら理由をhandoffに記録 |

## 構成

- `src/` — **配布ライブラリ（Eumenesへ取り込む）**。`zod` と `src/` 内部以外をimportしない。Bun・node・DOM・bench・Eumenesに依存しない（`bench/mock/guard.test.ts` が強制）。lib ES2022・`types: []` でビルドできること。
  - `contracts/definition.ts` 定義schema（暫定）、`contracts/component.ts` 部品カードとホスト側記録、`contracts/execution.ts` 1手順の実行契約（Eumenesの `ChildExecution`/`ChildResult` の部分集合）
  - `catalog.ts` 部品の解決（契約のみ。名前の類似や暗黙の既定入口で推測しない）、`check.ts` 定義の検査と実行計画、`ports.ts` ホストが渡す接続口（`PipelineHost`・`InferencePort`）
- `bench/` — P0評価専用。配布しない。
  - `catalog/` スナップショット読込み（immutable・digest照合）、契約の参照、棚卸し、カタログ版
  - `mock/` 到達ガード、合成値、モックホスト、実行ドライバー（Eumenesの実行器の代役）
  - `store/work-db.ts` 作業用SQLite（追記専用。トリガーで強制）
  - `infer/` `muse exec` の推論口、テスト用の固定応答
  - `fixtures/` 配線検証用の合成定義（評価ケースではない）
- `scripts/` — 契約の抽出、梱包
- `data/source/` カタログの写し（読み取り専用の証拠）。`data/contracts/` 抽出した契約とfixture。`data/catalog/` 生成物。`data/cases/` 評価ケース（未作成）。`data/runs/`・`data/work/` はGit管理外
- `vendor/router/` 固定したRouter tarball（devDependencyとして導入済み）

## 守ること

### 作業の安全
- サーバー・常駐プロセスを自分で起動・停止・再起動しない。必要なら利用者に依頼する。
- 取り消せない操作（`git reset/checkout/clean`、他人のファイル・データの削除、プロセスの強制終了）をしない。commit・pushは依頼されたときだけ。
- `../eumenes`・`../eumenes_router` を書き換えない。読み取りだけ。
- `data/source/` のスナップショットと `data/contracts/*.json` を手で編集しない。変える必要があれば再取得・再抽出し、理由と新しいdigestを記録する。
- 同じ版・同じ名前の配布物を差し替えない（`pack` が拒否する）。

### 判断はLLM、検査はコード（plan §5）
- 依頼の意味、部品の適否、作業分解、結果の充足はLLMが判断する。コードは schema・参照・順序・型・契約・状態だけを検査する。
- 語句辞書、キーワード判定、シナリオ別の条件分岐で意味判断を置き換えない。Routerの `RESOURCE_WORDS` 等の語句加点も、そのまま採用しない（plan §8）。

### 評価の公正さ（plan §9・§10）
- 正解ラベル・模範手順・許容解を、制作AI・検索器・モックの入力へ混ぜない。`MockHost` は正解を受け取らない作りを保つ。
- 実モデルの呼出しは `MuseExecInference` だけを使う。生きた実験では `installGuard({ allowProcess: allowMuseExec() })` を最初に呼び、`muse exec` 以外の外部到達を塞ぐ。Museは一時ディレクトリで動くので、このAGENTS.mdやケースは推論側へ渡らない。この隔離を弱めない。
- すべての実行を作業DBへrunとして記録する。条件を変えたら新しいrun（`parentRunId`）。完了した試行を消したり、同じ試行番号でやり直したりしない。
- 診断・選定用の例と、最終評価用の未見例を分ける。見た例を「未見」と呼ばない。
- 取得できない値（トークン、費用）を0や推定値で埋めない。null のまま報告する。
- fixture契約（`origin: fixture`）や要約のみの部品（`partial`）の結果は、`ready` の結果と分けて報告する。対応率は有効26件を分母にする。
- Ruri（文脈判定reranker）のProviderに触れない。2026-11-03に再学習したモデルを利用者が配備中。Router・rerankerの点数を使う測定では network名とモデルhashを記録し、network をまたいで結果を混ぜない。評価ケースとRuriの学習文の重なりを確認できるまで、Router経路の成績を未見データでの精度と呼ばない（詳細は引き継ぎ §7）。

### 取込み（plan §7）
- `src/` の公開APIを変えたら `bun run pack:check` と `bun run pack` の利用側検査を通す。
- 取込み時はEumenes側の薄いadapterが `PipelineHost`（→ agent-runtime の子実行）・`InferencePort`（→ LARM）・`ComponentRecord`（→ 登録済みtoolchain・binding・adapter説明）を実装する。Eumenesへの配置（`vendor/pipeline/`）と依存の変更は、利用者の承認後に行う。

## 完了の条件

変更ごとに `bun run check:all` と `bun run bench:verify --db :memory:` が通ること。通らない検査を省略したら、理由と未確認範囲を残す。同じ失敗が新しい根拠なく続いたら、編集と再実行を止めて原因仮説を見直す。
