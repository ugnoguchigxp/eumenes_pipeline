# Eumenes本体への接続案

2026-11-05。品質改善Q15の着手前調査。現在のpipelineの配布物は `eumenes-pipeline-0.0.0-32f778cb14b4.tgz`、SHA-256は `9ba750c488610ad39d280931e861e6d8fb6a6e44f118ce5900cb80ce8fcc62c9`。本体は `e917e920` を読み取り確認した。本体のコード、依存、DB、サーバーは変更していない。

旧P2の `work/pipeline-adapter-verify` / `9101985` は所在不明で、利用者から不在を前提に進めてよいとの回答があった。以下は現行コードから組み立てた変更案であり、旧ブランチを復元したものではない。

## 現行経路と接続できない箇所

- `api/domains/agent-runtime/service/execution-pipeline.ts` は、登録された旧形式pipelineを `startPipelineInTransaction` で起動し、`next` → `ops.launch` → `advance` を駆動する。
- `execution-store.ts` の `adoptChild` は、参照の採用、予算、確認待ち、失敗の状態を既存DBに残す。この経路を再利用する。
- `api/application/toolchain/task-execution-port.ts` は `ToolchainExecutionPort` を構成し、prepare、execute、adopt、cancel、参照検証を既存の各ドメインへ接続している。
- 旧形式は2手順以上、識別子はアンダースコア、引数に文字列の展開式を含む。新形式p0-3は1手順を許容し、ハイフンの識別子とJSONのリテラル引数を使う。登録済みの旧形式へ無条件に変換すると、手順数・識別子・引数・参照の契約を変えてしまう。

## 提案する変更範囲

| 場所 | 変更 |
| --- | --- |
| 本体の `vendor/pipeline/`、`package.json`、`bun.lock` | 検証済みtarball、checksum、manifestを配置し、依存を固定する |
| `api/application/pipelines/` | 原文、公開カード、カタログ版、権限を本体が保持した値として組み立て、p0-3の検査へ渡す薄い接続を追加する |
| agent-runtimeの公開起動口と親の保存状態 | 新しい短い定義を既存の親実行へ渡す。依頼ごとの一時定義を検索対象のtoolchainとして勝手に公開しない |
| `execution-pipeline.ts` と `execution-store.ts` の接続 | 新形式の手順・明示参照・最終配送を既存のlaunch/adopt/cancelへ写す。新しい実行ループや第二の状態台帳を作らない |
| 既存のpipelines／agent-runtime試験 | 1手順と複数手順、原文改変、未提示入口、検査不能引数、取消、期限、確認待ち、成否不明、所有者やdigestが違う参照、再実行の重複を確認する |
| 既存画面の状態表示とブラウザー試験 | 実装後に、部分成功・確認待ち・失敗を全成功として出さないことを確認する |

版は起動時に本体の既存規則で再解決する。計画の版と起動した版が異なる場合は、勝った版と理由を記録する。commandの受領票schemaを完了結果のschemaとして扱わない。参照はLLMの文章から作らず、本体が発行し認可した値だけを渡す。解釈と部品選択はLLM、順序・型・状態・権限の強制は既存コードが担う。

## 確認順

1. 本体の規則を読み、未保存の他作業と既存差分を再確認する。
2. 本体の分離した作業用コピーで、vendor整合性と公開API、1手順・複数手順の写像を確認する。
3. メモリーDB等の試験用資源で、既存launch/adoptの正常・異常・再開を検証する。
4. `pipelines`、`capabilities`、`agent-runtime`、`dialogue` の該当domain検査を行う。CIは利用者指定により追加・実行しない。
5. 本体で許可された試験資源と稼働環境が使えることを確認してから、短い依頼の実dispatch、資料の受渡し、最終提示、取消と画面を確認する。

サーバーの自動起動・停止・再起動、他のCodexチャットへの送信、実業務データの更新はこの案に含めない。実ツール確認では、対象と作用と費用を試験用の範囲に限定する。APIの費用は現在の共通10 USD枠へ含め、追加予算を前提にしない。

## 着手条件

このリポジトリのAGENTS.mdには「`../eumenes`・`../eumenes_router` を書き換えない。読み取りだけ」とあり、品質改善計画Q15も本体変更の明示的な依頼を開始条件にしている。本体への変更範囲が許可されるまでは調査とこの案の作成に留める。未実装の接続や実ホストでの受入を、今回のローカル検証済み項目へ数えない。
