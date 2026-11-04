# 評価環境: 構成と再実行の手順

plan §9・§10 の評価を、まっさらな状態から第三者が再実行するための手順。
対象は bench（配布物には含めない）。サーバー・常駐プロセスは不要で、外部への到達もない
（唯一の例外はローカルの tokenizer 計数サブプロセス）。

## 構成要素

| 要素 | 場所 | 役割 |
| --- | --- | --- |
| 評価ケース | `data/cases/<id>.json`（113件） | 依頼・渡された資料・正解（`expected`）・`split`（dev/holdout）・`group`。正解は評価器だけが読む |
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
  [--condition baseline|compact|oneshot] [--candidates <file.json>] [--repair]
```

recording が無いセルは `requests/<case>--<format>.json`（system・prompt・promptDigest）
が書かれ、missing として数えられて終了コード 1 になる。半端なセッションが完全に見える
ことはない。

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
