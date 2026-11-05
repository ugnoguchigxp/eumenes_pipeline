# 追加コードレビューと修正結果

2026-11-05。現在の公開ライブラリ、未コミットの改善差分、API・条件固定・採点・記録再生・梱包の境界をレビューした。**確認した7件を修正し、再レビュー範囲で未解決の具体的な指摘は0件**。意味判断をLLMから語句判定へ移す変更はない。

最終ソース識別は `74a4ba53967566892d27aa7feab6d08cf20a4ac7ae9fb2a6ff61eda9f120bdb8`。実装とレビューは同じ担当で行い、別工程の反証と別ディレクトリでの検証を使った。第三者の独立レビューではない。全ての不具合が存在しないことを保証するものではなく、実ホスト・CI・実ツール・利用者の実利用は今回の範囲外である。

## 指摘と解消

| ID・優先度 | 確認した条件と影響 | 修正と検証 |
| --- | --- | --- |
| CR01 / P1 | 同じファイル名の別候補に対する本物のAPI判定を移すと、対象候補への判定として受理された | 固定ケースと採点済み出力から共通のjudge requestを再構成し、schema込みのdigestを照合。不一致は有効票にせず、集計runも未完了とする。取り違えの反例は修正前に失敗、修正後に成功 |
| CR02 / P1 | provenance sidecarだけを書き換えると、usageや所要時間を変更して報告できた | 元のrun・trial・model call・phase・ファイル名・出力hash・元requestのバイトhashを照合。usageは不変DBと一致、時間はDB保存精度の丸めまで照合。改変反例を拒否 |
| CR03 / P1 | freeze後も、件数が同じならpromptと自己申告digestを一緒に差し替えて有料要求を送れた | 共通の準備処理が作った要求の一覧を追記DBへ保存。compose・repair・judgeの有料送信前に、同じfreezeの準備記録と全件照合。不一致は通信0件。初期化・保存先作成の失敗でもDBを閉じ、開始済みrun/trialを失敗として終える |
| CR04 / P2 | 応答の容量検査が全文読込み後で、大きい応答を途中で止められなかった。wire制限も文字数だった | 読込み中に2MBで打ち切り、bodyが止まっても期限でcancel。送信はUTF-8の200KBで制限。usageが不明な失敗では予約を保持。大きいstream・停止body・日本語のバイト数の試験に成功 |
| CR05 / P1 | 応答内のキーがUnicode escapeされた場合や識別子へ反射された場合、保存証拠へ残った | JSONを復号した値と保存する証拠全体を秘匿化。出力本文・response ID・provider request IDも対象にし、通常のusage・hashは保持。秘密を使った反例は修正前に失敗、修正後に成功 |
| CR06 / P1 | 同じAPI trialを別sessionにも置くと、複数回の独立要求として集計できた | 同じrun/trial IDの重複計上を拒否。実際の新規試行とコピーを区別する回帰試験に成功 |
| CR07 / P2 | manifest内の相対パスでも、ファイルや親ディレクトリのsymlinkを辿ってbundle外を読めた | パスの各階層のsymlinkを拒否。ファイル・ディレクトリ両方の外部参照を拒否し、正規bundleは成功 |

API由来のsessionをコピーした場合も元requestを独立に照合できるよう、bundleへ必要な元requestを追加保存する。これはCR02の照合強化に伴う配布要件であり、新しいモデル呼出しは行わない。CLIは薄い引数処理へ整理し、judge準備と集計は試験可能な共通処理へ移した。provider固有の意味判定、特定ケース用の製品分岐、新しいサーバーやCIは追加していない。

主な変更先は [API読込み](../../../bench/infer/api.ts)、[API記録の照合](../../../bench/infer/provenance.ts)、[準備記録](../../../bench/infer/prepared.ts)、[judge準備](../../../bench/scoring/prepare-judge.ts)、[集計](../../../bench/export/quality-report.ts)、[bundle](../../../bench/export/bundle.ts)。

## 検証結果

部分試験で反例を確認し、結合試験、全体検証、別の作業場所での再検証の順で進めた。

- `bun run check:all`: **388成功、0失敗**。通常・配布型検査、lint、整形も成功。
- `bun run bench:verify --db :memory:`: **87/87成功**、外部到達0件。
- 新しい空のソースコピーで、固定依存の導入・同じ全体検査・配線・`pack:check`が成功。
- 保存済みの実API出力48件と全judgeを強化した照合で再評価し、以前の集計値が一致。API記録の入力・usage・時間も不変DBと照合。
- 元DBへ依存しないbundleを別ディレクトリで導入し、48件の構造・意味判定・費用を再計算。新規run ID以外は一致、追加HTTP要求0件。

最初のソースコピーの検証では、新しい回帰試験が本番向けpolicyファイルへ依存して失敗した。その試験を自己完結した一時fixtureへ修正し、別の新しいコピーで検証し直した。失敗ログは保持し、必要な検査を省略したり期待値を弱めたりしていない。検証中にコードを書き換えて同じrunの結果と混ぜることもしていない。

今回の実API課金は追加0件。累計319件・未精算0件、費用の保守的上限 **5.204023 USD**、実請求額は引き続きnull。元の有料入力・出力・完了run・既存freezeは上書きしていない。最新の再集計は [quality-review-final](../../../data/evaluation/quality-review-final-2026-11-05/result.json)。同じ48出力を既見devとして再採点したもので、未見評価や新たな生成サンプリングではない。

前回の技術品質80.9点の台帳は、その時点のsnapshotとして保存する。今回の修正件数を点数へ加算していない。モデルの不適切な選択やjudgeの不一致も残しており、コードの検証成功を実ツール成功や全件の意味的正解へ置き換えていない。

## 再現用の保存物

[最終bundle](../../../artifacts/code-review-evidence-2026-11-05-74a4ba539675/standalone-evidence.tar.gz) は2726ファイル、約5MB。SHA-256は `c992fc8f4366c97267d2c85bfcd20773bcf0565f6e74d98bde75dc7885b6666a`。コード、元の入力とAPI記録、必要な元request、依存、ケース、独立に開けるSQLiteを含む。リポジトリ外の新規ディレクトリに展開してから実行する。

```sh
bun install --frozen-lockfile --ignore-scripts
bun run bench:replay -- --replay
```

全48件の集計は同梱の `data/replay-source.sqlite3` を別名の `data/quality-replay.sqlite3` へコピーして、`docs/evaluation.md`の手順を最新の`quality-review-final`名で行う。比較で除くのは `reportRun` と `generations[].scoredRunId` のみ。実施済みの [照合結果](final-standalone-result.json) と [別環境の検査ログ](final-clean-gate.log) を保持した。

今回の差分は本リポジトリ内のみ。`src/`の公開API、配布ライブラリのデータ契約、既存のtarballは変更していない。本体・契約snapshot・CI・`.zprofile`・他チャットは変更せず、新たなcommit/pushも行っていない。
