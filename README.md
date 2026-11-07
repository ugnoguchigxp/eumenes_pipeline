# Eumenes Pipeline

[Eumenes](https://github.com/ugnoguchigxp/eumenes) に登録されたツールチェーンバンドルを部品として、AIが利用者の依頼を作業に分解し、部品を選び、成果物までの流れを短い定義（`request`・`steps`・`output`）に残すためのサブプロジェクト。ビルドした tarball を Eumenes に取り込んで使う。

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

配布版 **0.1.0**、内部データ契約 **p0-3** をEumenes本体へ取込み済みです。JSON生成、検査、モック実行、追記専用DB、結果のexport、Claude/OpenAI APIの検証口を実装しています。限定したlive検証では、実モデルの計画から計算→15秒タイマーの子2件が完了し、画面の描画・通知も一部確認しました。通常会話の複数作業、質問への回答・継続、取消を含む通し受入は本体側で進行中です。モック成功と実ツール成功、限定したlive成功と全体受入を分けて扱います。

採用版・設計判断・確認済み範囲は [改善設計書の決定欄](docs/plans/improvement-design-2026-11-06.md#0-2026-11-06-の決定と実施)、本体の最新受入状況は [本体の課題台帳](../eumenes/spec/project-issues-2026-11-06.md) と [進行中の実装・検証記録](../eumenes/spec/project-issues-first-batch-2026-11-06.md) を参照してください。本体の振り分け・質問継続・実dispatch・画面の作業はそちらで管理し、会話への完了報告・結果通知の追加案は撤回済みです。計画の正本は [plan.md](plan.md)、11月5日までの結果は [品質改善記録](docs/handoff/2026-11-05-quality-improvement.md) に残しています。古い計画・評価を現在の採用状態として読み替えないでください。

JSONは基準の比較条件で、既定は全カード提示です。修復・構文復元・ID正規化・triage・段階生成は既定offの実験条件です。段階生成とtriageは採用していません。旧holdout40件は既見の診断集合として扱います。

本体の指示文を測る `eumenes` 条件は、抽出した指示文・カードの写像・出力の読み方を固定する実験条件です。[評価手順](docs/evaluation.md#本体の指示文を測る条件2026-11-06)に従って使い、旧bench条件のAPI成績をこの条件の測定結果へ転用しません。

既定の指示文は本体の続行検証で使ったrevision 2です。`--host-prompt` と `--host-toolchain-revision` で旧版も指定できます。freezeでは指示文と出所を固定し、使用したsnapshotは証拠bundleへ保存します。カード・資料・回答履歴は本体との近似が残り、実ツールと最終成果物までの品質実測は未完了です。

指示文を再抽出するときは、測定対象の本体で採用した `toolchainRevisionId` を確認します。バンドルに複数revisionがある場合は `--toolchain-revision toolchain:pipeline.execute@N` が必須です。既知の指示文digestがあれば `--expected-instructions-sha256 <SHA-256>` も指定すると、不一致時に保存前に止まります。配列順や最大revisionから稼働版を推測しません。抽出は本体を読み取るだけで、登録・設定・稼働状態は変えません。

選択結果のunion再分析は、元結果のcase snapshot・catalog版・embedding由来を現在の入力と照合します。依頼文やカードが変わった場合、過去の順位と混ぜず元の入力で再生するか、新しいrunで全順位を測ります。照合情報のない旧結果は、保存済みの当時のソース・証拠bundleで再生してください。

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

### 0.1.0 の追加（契約p0-3のまま）

定義・制作結果・記録のJSON形は変えていないため、契約版はp0-3のままです。

- `parseJsonStrict(text)`: モデル出力を読む厳格なJSON読取り。重複キー・末尾の余分な内容・深さ64超（`MAX_JSON_DEPTH`）を拒否し、`__proto__` なども自身のプロパティとして保ちます。`JSON.parse` は重複キーの最後を黙って採用するため、制作結果の解析には使わないでください。benchと同じ実装です。
- `bindSourceRequest(definition, sourceRequest)`: ホストが保持する原文を定義の `request` へ結び付け、モデルが書いた文（`written`）と一致したか（`matched`）を返します。モデルの書写しの誤りで計画を落とさず、記録には残すための構造的な置換で、意味は判定しません。
- `isRunnable(record)` と実行可否の多層検査: `createCatalogView` は、無効・`excluded`・初版で扱わない実行種別（`session`、`task`、`pipeline` など）を、ホストの `offer` に関わらず提示しません。自作の `CatalogView` が解決した場合も、`checkDefinition` が `component_not_runnable` で止めます。`IssueCode` に値が1つ増えたため、網羅的にswitchしている利用側は対応が必要です。

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
