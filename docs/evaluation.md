# 評価環境: 構成と再実行の手順

plan §9・§10 の評価を再実行する手順。benchは配布物に含めない。通常の検査と記録再生にはサーバーもAPIキーも不要。

2026-11-05の変更: 契約p0-3、採点器 `bench-format-v3`。新しいrunはコードのcontent identity、ケースの原文とdigestを実行時に固定する。exportはそのsnapshotを使い、現在のケースで過去の正解を置き換えない。旧runは記録されている範囲だけを表示する。

`data/cases/` の旧holdout40件は、既に後続方式の検討に使われた診断集合である。新しい未見精度の根拠にしない。今回の新規24件は `data/evaluation/quality-2026-11-05/` で実呼出し前に固定した。事後のgold監査とjudge修正後は、同じ出力を既見devとして `data/evaluation/quality-finalized-2026-11-05/` に再集計し、未見評価とは呼ばない。作成担当AIには内容が見えているため、作成者に対する盲検とは呼ばない。制作APIには依頼・公開カード・提供資料だけを渡し、正解は渡さない。

実APIは明示した `bench:infer` だけが選択providerの公式HTTPS endpointへ到達する。通常試験と `bench:verify` の通信0件は維持する。キーの継承と共通予算の使い方は [README](../README.md#apiでの検証) を参照。生成時間と再生時間、費用上限の計算値と実請求を区別する。

証拠を独立に再生する場合、`bench:replay -- --run <id> --db <path> --bundle <新しい空でない保存先名>` で一式を保存する。保存先の親ディレクトリは事前に作る。bundle内で `bun install --frozen-lockfile --ignore-scripts`、`bun run bench:replay -- --replay` を実行すると、固定した元ケース・コード・出力から再計算し、元DBの判定と照合する。元の作業DBや可変summaryは不要。改変や欠損は拒否し、APIは再呼出ししない。bundleは試験の探索対象へ混ぜないよう、リポジトリの外へ置く。

## 構成要素

| 要素 | 場所 | 役割 |
| --- | --- | --- |
| 評価ケース | `data/cases/<id>.json`（116件） | 依頼・渡された資料・正解（`expected`）・`split`（dev/holdout）・`group`。正解は評価器だけが読む |
| カタログ snapshot | `data/source/`（読み取り専用）+ `data/contracts/` | 部品カードの出所。digest 照合つき。再生成は `bun run bench:catalog` |
| 作業DB | `data/work/bench.sqlite3` | run / trial / model call / check / mock call / score の追記専用記録。削除・完了後の書換えはトリガーで拒否される |
| セッション | `data/runs/format/<session>/` | `requests/`（生成役への入力）・`recordings/`（生成役の出力）・`summary.json`（最新の run の集計） |
| export | `data/runs/exports/<runId>.json` / `.md` | 1つの run を第三者が検証できる形に書き出したもの（`bun run bench:export`） |

版の追跡: 各 run は `inputs` に snapshot / contracts / fixtures の SHA-256 とカタログ版、
ケース ID 集合を記録する。各ケースの gold は export がファイル自体の SHA-256 で固定する。
契約版は P3 以降の run から config にも記録される（それ以前の run は digest 群が版の固定手段で、
export は記録なしを null のまま示す）。

## 前提

1. `bun install`（依存は zod のみ＋dev 依存）。
2. トークン計数には対象モデル系の tokenizer が要る。既定の置き場所は
   `~/workspace/tools/lfm-tokenizer/tokenizer.json` で、`PIPELINE_TOKENIZER_FILE` /
   `PIPELINE_TOKENIZER_PYTHON` で差し替えできる。無い場合、トークン数は null のまま
   （文字数で代用しない）。
3. 推論は agent-model 方式: 生成は bench の外（盲検の生成役）が行い、bench は記録の
   再生だけを行う。実モデル呼出しは `MuseExecInference` のみ（AGENTS.md の隔離規則）。

## 手順

### 1. 配線確認

```
bun run bench:verify --db :memory:
```

合成 fixture で parser・validator・モック・採点の正常系と異常系を確認する（87件）。
記録を残さないので、作業DBの状態に影響しない。

### 2. セッションの用意（request 生成）

```
bun run bench:format -- --session <name> [--case id,id] [--format json,md-yaml,free-md] \
  [--condition baseline|compact|oneshot] [--candidates <file.json>] [--repair] \
  [--staged] [--coverage-repair]
```

recording が無いセルは `requests/<case>--<format>.json`（system・prompt・promptDigest）
が書かれ、missing として数えられて終了コード 1 になる。半端なセッションが完全に見える
ことはない。

`--staged` は段階生成（段階A: 作業項目の列挙を `enum-requests/`・`enum-recordings/` で
記録再生し、項目リストと印の規約を制作プロンプトへ渡す。段階Cの `--coverage-repair` は、
機械的に健全で項目の未カバーが残るセルに、未カバー項目を機械エラーとして修復を1回渡す）。
列挙が使えないケースの制作セルは、triage と同じく blocked として数えられる。

### 3. 生成（盲検）

生成役は、そのケースの request ファイルだけを読む。ケース定義・正解・採点コード・
他ケースのファイルは渡さない。成果物は `recordings/<case>--<format>.json` に
`{promptDigest（request の値を正確に転記）, output}` として置く。
`--repair` の場合は、機械的失敗セルについて `repair-requests/` に修復 request が出るので、
同じ要領で `repair-recordings/` に置く（修復は1回だけ、対象は parse / authoring /
checkDefinition の機械的失敗のみ）。

### 4. 採点（再実行）

同じコマンドを再実行する。全セルに recording があれば parse → authoring 契約 →
`checkDefinition` → mock 実行 → 採点までが再生され、新しい run として作業DBへ追記される
（完了した試行は書き換えない）。`summary.json` はその run のものに更新される。
終了コード 0 が「全セル採点済み」の印。

### 5. レビュー / export

```
bun run bench:export -- --run <runId>
```

合計は作業DBの score 行から再計算され、セッションの `summary.json` が同じ run のものなら
全項目（合計・セル状態・判定・修復の前後・トークン）を照合する。不一致は終了コード 1 で
報告される。summary が後続の再実行で別の run のものになっていた場合は「superseded」と
報告され、不一致とは扱わない（その場合トークンは export に載らない = null）。

### 6. 再現確認（実施例）

seed 12件・baseline・3形式は、複写したセッションと新しい作業DBで再現できる:

```
cp -r data/runs/format/p0d-agent-model-1 data/runs/format/<scratch>
bun run bench:format -- --session <scratch> --db <新しいDBのパス> \
  --case prime-count,weather-timer,edo-research-image-music,stock-quote,kanban-add,\
screenshot-ocr,browser-shot,history-lookup,compute-to-kanban,vague-request,missing-table,bank-transfer
```

2026-11-04 の実施では、記録済み run `327f4f56` と完全一致した:
cells 36・scored 36・missing 0・digest mismatch 0、parse 36/36・check 27/27・
state 36/36・bundles 36/36・mock 27/27・passed 36/36、
prompt 194,661 tokens・output 4,753 tokens、終了コード 0。

## 規律

- `holdout` のケースは調整（形式・プロンプト・閾値・候補数）に使わない。方式を凍結した
  後の最終評価専用（P4）。
- fixture 契約に依存するケース（`usesFixtureContracts`）の成績は、catalog 由来のケースと
  常に分けて報告する。
- 取得できない値（トークン・費用）は null のまま報告し、0 や推定で埋めない。
- 条件を変えたら新しい run。完了した試行を消したり、同じ試行番号でやり直したりしない。
- 合成（synthetic）出力は配線確認専用で、測定として報告しない。

## 2026-11-05の最終評価と独立再現

技術品質は [再評価報告](reviews/2026-11-05-quality-reevaluation/report.md) の正式80.9点。モデルの成功率とは別の点数で、CIと本体接続は今回の対象外。APIの請求実額はnull、保守的費用上限は5.204023 USD。native schemaの意味judgeと、通常JSON生成の実測を区別する。

再現一式は `artifacts/quality-evidence-2026-11-05-d8ac16d99861/standalone-evidence.tar.gz` と同じ場所のSHA-256/manifest。リポジトリ外の新しいディレクトリへ展開し、ハッシュを確認してから、依存を固定導入する。`bun run bench:replay -- --replay` は元の24セルをAPIなしで検算する。

全48セルと意味判定の再集計は、同梱の `data/replay-source.sqlite3` を **別名の** `data/quality-replay.sqlite3` へコピーし、両sessionをそのDBへ記録する。元DBは変更しない。

```sh
bun run bench:format --session quality-finalized-luna --cases data/evaluation/quality-finalized-2026-11-05/cases --format json --freeze data/evaluation/quality-finalized-2026-11-05/freeze.json --db data/quality-replay.sqlite3
bun run bench:format --session quality-finalized-sonnet --cases data/evaluation/quality-finalized-2026-11-05/cases --format json --freeze data/evaluation/quality-finalized-2026-11-05/freeze.json --db data/quality-replay.sqlite3
bun run bench:quality-report --freeze data/evaluation/quality-finalized-2026-11-05/freeze.json --budget data/policies/api-validation-standard-2026-11-05.json --db data/quality-replay.sqlite3 --out data/independent-quality-result.json
```

同梱の最終resultと比較し、新規に発行する `reportRun` と `generations[].scoredRunId` だけを除外する。実施済みの比較は [照合記録](reviews/2026-11-05-quality-reevaluation/final-standalone-result.json) と実行ログに保存した。再現用ルートの生成JSONとソース検査の対象は異なるため、通常の全体検査は元ソースを別コピーして行う。元の正本の整形や、検査条件の弱体化で帳尻を合わせない。

新しいAPI記録は `evidence: api` とschema digestの由来を要求する。旧記録でschemaが不明なら、そのまま現在の契約へ流用しない。旧ソースのarchiveで再生するか、保存済みの実requestを不変DBのhashと照合し、新規の派生記録に移行する。今回の移行では入力/出力を変えず146件を派生し、元ファイルを保持した。移行manifestも再現archiveに含む。

## 追加コードレビュー後の手順

[コードレビュー結果](reviews/2026-11-05-code-review/report.md) で要求と由来の照合を強化した。現在の再集計は `data/evaluation/quality-review-final-2026-11-05/`、再生sessionは `quality-review-final-luna` と `quality-review-final-sonnet`。以前のsnapshotとarchiveは当時のコードで再現する。

freeze付きの新しい有料検証では、同じfreezeと作業DBで先に要求を準備する必要がある。formatの準備も `--freeze` を付け、judge準備には次を指定する。

```sh
bun run bench:judge:prepare --source SOURCE_SESSION --session JUDGE_SESSION --cases CASES_DIR --freeze FREEZE_FILE --db WORK_DB --native-schema
```

`--native-schema`の有無もfreezeと一致させる。`bench:infer`は送信直前に、件数だけでなく準備記録の各request digestを照合する。準備後の差し替えや、別条件・別DBの要求を同じ試行へ混ぜない。旧API sessionは記録を保持し、新しいsessionを使う。

現在のquality reportは、不変DBの元API呼出し、元requestの原文hash、phase・ファイル名・usage・保存精度の時間まで照合する。候補に対するjudge入力も再構成する。同じtrialの重複計上は拒否する。元requestのあるsessionも保存し、独立bundleへ必要な原文を含める。

## 本体の指示文を測る条件（2026-11-06）

`--condition eumenes` は、Eumenesが実際に送る組み立てプロンプトを送る。中身は次のとおり。

- 指示文: bundle `pipeline-execution` の profile と skill
- メッセージ: JSON の利用者メッセージ
- カード: 本体の写像

読み方も本体に合わせる（未trim、`status` 必須、原文の結び付け）。結び付けた不一致は、止めない警告 `request_mismatch` として記録する。

- **形式**: json だけ。修復・構文復元・ID正規化・triage・段階生成とは併用できない（本体の修復メッセージを再現していないため）。
- **指示文の抽出**: `bun scripts/extract-eumenes-prompt.ts` で `../eumenes` から読み取り専用で抽出する。
  - 既定は、11月6日夜の本体の続行検証で使った `toolchain:pipeline.execute@2` の `data/contracts/eumenes-compose-prompt-v2.json`。旧revision 1の `data/contracts/eumenes-compose-prompt.json` は履歴として保持する。いずれも手で編集しない。
  - bundleが未commitなら読込みを拒否する。
  - 写した本体ファイル（カード写像、メッセージ組立）のcommit時digestと未commitの有無も記録する。
  - 抽出し直したら、理由と新しいdigestを記録する。
- **近似**: bench のケースには資料の内容と本体の参照が無いので、資料は名前と種別だけになる。`answers` は空。カードは本体の現行登録ではなく、benchカタログの提示カードを写像した物。
- **実測**: まだ行っていない。新しいsessionとrunで、予算台帳を使って行う。

### 評価する版の指定と固定（2026-11-07）

抽出する版は、本体の採用記録と照合して明示する。複数revisionのあるバンドルから、配列の先頭や最大revisionを自動で選ばない。

```sh
bun scripts/extract-eumenes-prompt.ts \
  --toolchain-revision toolchain:pipeline.execute@2 \
  --out data/contracts/eumenes-compose-prompt-v2.json
bun run bench:format -- --session host-v2-prepare --format json --condition eumenes \
  --host-prompt data/contracts/eumenes-compose-prompt-v2.json \
  --host-toolchain-revision toolchain:pipeline.execute@2
```

後者は記録が無ければ要求ファイルを準備して終了コード1となる。APIは呼ばない。旧版の再生では `--host-prompt data/contracts/eumenes-compose-prompt.json --host-toolchain-revision toolchain:pipeline.execute@1` を指定する。指定版とsnapshotが一致しなければ停止する。他の条件にhost専用optionを渡した場合も停止する。

未使用ケースを実測する前に、要求準備の `summary.json` にある `condition.hostPrompt` を、freeze用protocolの `formatMethod.hostPrompt` へそのまま含める。ここには指示文のdigest、本体commit、toolchain revision、snapshot全体のdigest、入力の近似範囲を記録する。保存場所のpathだけを固定値として使わない。freeze後の指示文・revision・出所の差し替えは、要求の生成・再生前に拒否する。

使用したsnapshot本文も作業DBへ保存する。証拠bundleはその本文を `data/replay-host-prompt.json` に同梱し、`bench:replay -- --replay` はそれを読む。元の外部snapshotが後で変わっても、その時点の指示文を再現する。

**この条件が測れる範囲**は計画生成である。runの `inputMode: bench-catalog-material-labels-no-answers` は、カードがbenchの写し、資料が名前・種別だけ、回答履歴が空であることを示す。本体と完全に同条件、質問後の再開、実ツールの成功、最終成果物の正しさの証拠にはしない。これらの受入には、本体側で固定した実行条件と結果の照合が必要である。新しい未使用ケースの作成・固定と実API測定も未実施で、旧24件の成績は更新していない。

### runnerの責務

`bench/format/prepare.ts` は条件検査と要求の準備、`run.ts` は追記記録・セル評価・修復の実行、`report.ts` は集計とsummaryの書出しを持つ。既存の条件と失敗時の扱い、採点基準は維持する。構造整理の受入では、APIを呼ばず保存済み48出力を別DBへ再生し、run IDを除くsummary、各ケースの結果、採点行を比較する。
