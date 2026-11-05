# Eumenes Pipeline

[Eumenes](https://github.com/ugnoguchigxp/eumenes) に登録されたツールチェーンバンドルを部品として、AIが利用者の依頼を作業に分解し、部品を選び、成果物までの流れを短い定義（`request`・`steps`・`output`）に残すためのサブプロジェクト。最終的に tarball として Eumenes に取り込む。

```json
{
  "request": "江戸時代の町並みを調べて、解説付きの画像と30秒のBGMを作って",
  "steps": [
    { "id": "research", "bundle": "web.search", "task": "町並みの特徴を出典付きで調べる", "from": ["request"], "result": "制作に使える調査結果" },
    { "id": "picture", "bundle": "image.create", "task": "特徴を反映した画像を作る", "from": ["request", "research"], "result": "町並みの画像1点" },
    { "id": "music", "bundle": "music.create", "task": "雰囲気に合う30秒のBGMを作る", "from": ["request", "research"], "result": "30秒のBGM1曲" }
  ],
  "output": { "from": ["research", "picture", "music"], "deliver": "画像とBGMを提示し、解説と出典を添える" }
}
```

組み立てるAIは部品内部のプロンプト・ツール・APIを読まず、部品の用途・入出力・制約だけを見て組合せと受け渡しを決める。意味の判断はLLMが行い、コードは schema・参照・順序・型・契約・状態だけを検査する。

## 状態

内部データ契約は **p0-3** として固定済みです。JSON生成、検査、モック実行、追記専用DB、結果のexport、Claude/OpenAI APIの検証口を実装しています。Eumenes本体の実dispatchと画面での受入は未完了です。モック成功は実ツールの成功を表しません。

現在の確認範囲は [品質改善記録](docs/handoff/2026-11-05-quality-improvement.md)、計画の正本は [plan.md](plan.md)、改善項目は [実装計画](docs/plans/quality-improvement-2026-11-05.md) を参照してください。JSONは基準の比較条件で、既定は全カード提示です。修復・構文復元・ID正規化・triage・段階生成は既定offの実験条件です。段階生成とtriageは採用していません。旧holdout40件は既見の診断集合として扱います。

## 必要なもの

- [Bun](https://bun.sh) 1.4.4（`packageManager` で固定）
- API検証のみ: 環境変数 `CLAUDE_API_KEY` と `OPEN_AI_API_KEY`。標準名 `ANTHROPIC_API_KEY` と `OPENAI_API_KEY` も使えます。プロジェクトの `.env` は不要です
- Muse経路を明示して使う場合だけ、ログイン済みの `muse` CLIが必要です

## 使い方

```sh
bun install --frozen-lockfile
bun run check:all                 # 型検査（通常・配布ビルド設定）・lint・整形確認・全テスト
bun run bench:catalog             # カタログの写しから部品を棚卸し → data/catalog/
bun run bench:verify --db :memory: # 通信なしの配線検証（定義の検査・モック実行・停止規則・到達ガード）
bun run pack:check                # 配布物の中身の検査（書き込みなし）
bun run pack                      # artifacts/<名前-版-digest>/ に tarball・.sha256・manifest.json を作る
```

テストと `bench:verify` の実行中は、ネットワーク・外部プロセス・実ツールへの到達を到達ガードが塞ぐ。

## APIでの検証

最初に `bun run bench:format -- --session <名前> --format json` で送信対象の依頼ファイルを用意します。この段階の未生成表示は想定どおりです。キーを環境から継承したログインシェルで次を実行します。Claudeは `--provider anthropic --model claude-sonnet-5-5` に置き換えます。

```sh
/bin/zsh -lc 'exec bun run bench:infer -- --provider openai --model gpt-6-luna --session <名前> --budget data/policies/api-validation-standard-2026-11-05.json'
bun run bench:format -- --session <名前> --format json
bun run bench:export -- --run <採点runのID>
```

両社・生成・修復・judgeは共通の予算台帳を使い、実行上限8.5 USD、承認上限10 USDです。タイムアウトやusage不明の試行も予約を残し、無断で再送しません。同じ記録へ上書きせず、新しい試行は別sessionとrunを使います。生成時間と再生時間、費用上限の計算値と実請求を区別します。実請求を取得できない欄はnullです。

`bench:judge:prepare` は元の依頼・公開カード・候補だけから評価用の入力を用意します。正解、生成モデル名、費用は評価モデルへ渡しません。APIの成功は、候補が依頼を満たしたという判定ではありません。

評価では、構文と契約への適合、参照ケースへの適合、意味の適切性を別に示します。判定器には公開契約と既存checkerの解決結果を渡し、入口IDとバンドル名の違いを再推測させません。これらの判定は実ツールの成功や実利用での成果を表しません。旧条件のHaikuやキャッシュを含む保守的な予算policyは、診断記録の再現用に保持します。

## 利用側の境界

p0-3では、公開validatorの型を `Schema<T>`（`parse` と `safeParse`）へ限定しました。定義のJSON形はp0-2と同じです。Zod固有の拡張メソッドを使っていた利用側は、この公開口へ移行してください。修正版Zodの内部型が要求するブラウザー型を、利用側の要件へ持ち込まないための変更です。

引数はJSONのデータだけを受け付け、先頭32キー、深さ64、合計10,000要素、文字列とキーの合計100,000文字単位までです。循環参照・関数・アクセサー・非有限数を拒否し、受理した値は複製して計画へ渡します。

実行前に `checkDefinition(definition, catalog, { sourceRequest: originalRequest })` を使うと、ホストが保持した原文との完全一致を照合し、検査できない引数もエラーとして止めます。2引数の旧呼出しでは原文の真正性を保証せず、`arguments_unchecked` は警告に留まります。

ホストは入口の権限、参照の所有とdigest、版、取消、期限、作用の重複を既存の実行基盤で検査する必要があります。ライブラリとbenchのガードは、権限管理やOSの隔離の代わりにはなりません。

## 構成

| パス | 内容 |
| --- | --- |
| `src/` | 配布ライブラリ。定義schemaと検査、部品の解決、1手順の実行契約、ホストの接続口（`PipelineHost`・`InferencePort`）。`zod` 以外に依存せず、Bun・Node・DOM・Eumenesをimportしない |
| `bench/` | 評価専用（配布しない）。カタログ、モック、到達ガード、追記専用DB、Muse・Claude・OpenAIの推論口、記録再生、意味評価の入力準備 |
| `scripts/` | Eumenesからの契約の抽出（読み取りのみ）、梱包と空の利用側での検査 |
| `data/source/` | Eumenesのカタログ6テーブルの写し（読み取り専用、manifestのSHA-256で照合） |
| `data/contracts/` | Eumenesのコードから抽出した入出力のJSON Schema、benchだけで使うfixture契約 |
| `data/catalog/` | `bench:catalog` の生成物（棚卸し・部品カード） |
| `vendor/router/` | 比較に使う固定版の [eumenes_router](https://github.com/ugnoguchigxp/eumenes_router) tarball |
| `docs/` | 文書レビューの記録、引き継ぎ |
| `AGENTS.md` | このリポジトリで作業するエージェント向けの規則 |

## Eumenes への取込み

1手順は、Eumenesに登録されたtoolchain入口の子実行1回に対応する。`src/` の型はEumenesの `ChildExecution`・`ChildResult`・`ExecutionReference` の部分集合で、取込み時はEumenes側の薄いadapterが `PipelineHost`（agent-runtime）、`InferencePort`（保存済みのLARM接続）、部品記録（登録済みtoolchain・binding・adapter説明）を実装する。配布物はビルド済みESMと型宣言だけを含むtarballで、Eumenesの `vendor/` と同じ配置で manifest・checksum を添える。

## データについて

`data/` の写しと契約は同じ作者の Eumenes から取得したもので、設定・認証情報・会話・業務データは含めていない。作業用SQLite（`data/work/`）と実行記録（`data/runs/`）はGit管理外。いずれも配布tarballには含めない。

## ライセンス

[MIT](LICENSE)
