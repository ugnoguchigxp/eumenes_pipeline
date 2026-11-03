# Handoff — JSON 構文復元段（syntax restore）（2026-11-04）

対象モデル（LFM2.5）では末尾カンマ・閉じ括弧不足・文字列の途中切断・フェンス混入など
構文レベルの崩れが予想されるため、厳格 parser の前段に決定的な構文復元を1枚入れた。
強いモデル役（agent-model）の測定では parse 失敗は全セッション 0 件だったので、これは
未測定の失敗クラスへの備えであり、命中率は対象モデルでの測定まで分からない。

修復ループ（`--repair`、LLM に機械エラーを返して直させる方式）とは失敗クラスが違う
補完策: 復元段は構文だけを決定的に直し、修復ループは schema 値レベルの誤り
（step ID の snake_case 違反など）を扱う。

## 採用ライブラリ

| 項目 | 内容 |
| --- | --- |
| ライブラリ | `jsonrepair`（josdejong）**3.15.0**、devDependency のみ |
| 導入 | `bun add -d jsonrepair`（bunfig の7日ルール通過）。自前実装への fallback は不要だった |
| 配置 | bench のみ（`bench/formats/restore.ts`）。`src/` は不変更で、tarball の依存は従来どおり zod のみ |
| 依存する挙動（テストで固定） | 重複キーは出力テキストにそのまま残す（潰さない）。前後の散文や空入力では例外を投げる（黙って除去しない） |

## 統合方式

- CLI: `bench:format --restore-syntax`（runFormat の `restoreSyntax` option）。**既定 off**。
  off のときの挙動・digest・summary 形状・記録 criteria は従来と完全同一（既存テスト＋
  下記の冪等性再走で担保）。
- 対象は **json 形式のみ**（jsonrepair は JSON 専用。md-yaml / free-md には適用しない）。
- セル処理（`bench/format/run.ts`）: 厳格 parser が成功すれば復元は発動しない。失敗した
  ときだけ復元を1回試み、復元後のテキストを**同じ厳格 parser** に通す。復元しても parse
  できない場合は、記録される失敗はモデルの原文に対する生の parse 失敗（エラーコードは
  復元器ではなくモデルのテキストを記述する）。
- recordings ファイルは読み取りのみで、絶対に書き換えない（配線テストでバイト一致を確認）。
- 追跡可能性: on のとき run config に `restoreSyntax: true` と `restoreEngine:
  "jsonrepair@3.15.0"` を記録。各試行に criteria `syntax_restored`（1/0）を記録し、
  summary.json と export にセル単位の `syntaxRestored` フラグと集計
  （`restore: {attempted, recovered}`、composing セルのみ）を併記する。parse の採点は
  復元後の結果で評価するが、復元適用の事実が別に残るため「生の parse 成功率」は
  後から分離できる（parse 失敗したセルは attempted に数えられる）。
- 復元後の出力も従来どおり authoring 契約・checkDefinition・モック・採点の全ゲートを
  通る。復元は「評価可能な形にする」だけで合格を保証しない。切断の復元で手順が欠落した
  定義は採点で落ちるのが正しい挙動であり、意味的な補完はしない。
- export（`bench/export/export.ts`）: 復元されたセルの保存形定義は、runner と同じ復元を
  通して再導出する（生出力は不変更）。復元 totals は criteria から再計算し、summary の
  `restore` と突合する（`summaryCrossCheck.restoreEqual`）。
- 修復ループとの接続: 復元で parse が回復したセルは通常どおり後段へ進む。復元しても
  parse が失敗するセルは、元の機械エラーのまま修復ループの対象になる。

## 厳格さの維持（重複キー）

重複キーは曖昧さであり、復元で黙って解決して通してはいけない。jsonrepair は重複キーを
出力テキストに保持するため、復元後の厳格 parse が `duplicate_key` で落とす。この性質は
汚損スイートで（純粋な重複／末尾カンマとの混合の両方）固定した。将来 jsonrepair の版を
上げてこの挙動が変われば、スイートが落ちて気づける。

## 汚損スイート結果（`bench/formats/restore.test.ts`、12件、決定的単体テスト）

素材は合成出力（prime-count の正常な定義 JSON）。

| クラス | 汚損 | 結果 |
| --- | --- | --- |
| (a) 末尾カンマ | array / object の末尾に `,` | 復元可。定義は元と deep-equal |
| (b) フェンス包装 | ` ```json ` / 素の ` ``` ` | 復元可。deep-equal |
| (c) シングルクォート | 文字列・キーを `'` に置換 | 復元可。deep-equal |
| (d) キーのクォート漏れ | キーの `"` を除去 | 復元可。deep-equal |
| (e) コメント混入 | 行コメント・ブロックコメント | 復元可。deep-equal |
| (f) 閉じ括弧不足 | 末尾の `]}` を欠落 | parse まで回復。同等性は主張しない（ゲートで落ちうる） |
| (g) 文字列の途中切断 | 全体の55%で切断 | parse まで回復。定義は元と **不一致**（欠落は補わない） |
| (h) 重複キー | 純粋な重複／末尾カンマとの混合 | 復元後も不合格（`duplicate_key`） |
| (i) 正常な出力 | 汚損なし | 復元は発動しない（attempted=false、フラグなし） |

加えて配線テスト2件: run レベル（フラグなしでは parse 失敗のまま／ありでは回復して
passed・`restore {attempted: 1, recovered: 1}`・recording バイト不変／重複キーは
`{attempted: 1, recovered: 0}` で不合格のまま）と、export レベル（フラグ・保存形定義・
復元 totals・突合 `restoreEqual: true`）。

## 実データ冪等性（`--restore-syntax` で既存セッションを再走）

全出力が元々 parse できるため、復元発動 0 件で totals が完全一致するはず、という検証。
再走は新規 run として作業 DB に記録され（run の使い回しはしない）、scoped 再走で
上書きされる summary.json は事前バックアップして元の run のものへ復帰済み
（dev は `766c7dc2`、holdout は `75a5831c` の summary）。

| セッション | オラクル run | 再走 run | totals | 復元 |
| --- | --- | --- | --- | --- |
| dev-baseline-1（60件×3形式） | `3ed1ea67` | `abfc789a` | passed 170/180・parse 180/180・authoring 180/180・check 144/144・state 171・bundles 171・mock 144/144、形式別 passed も一致（json 57 / md-yaml 57 / free-md 56）。トークンも一致（prompt 974,199 / output 29,065） | attempted 0 / recovered 0 |
| holdout-baseline-1（40件×json、compose のみ） | `e1e4f609` | `73a2e7db` | passed 27/40・parse 40/40・authoring 31/40・check 23/23・state 38/40・bundles 35/40・mock 23/23 で一致 | attempted 0 / recovered 0 |

export 側でも両再走 run の `restore` が `{attempted: 0, recovered: 0}` で再計算される
ことを確認した。

## ゲート

| ゲート | Before | After |
| --- | ---: | ---: |
| `bun run check:all`（型・lint・整形・全テスト） | 278 tests | **292 tests / 0 fail**（+14: 汚損スイート12＋配線2） |
| `bun run bench:verify --db :memory:` | 87/87 | **87/87** |

## 残る留保

- **対象モデルでの命中率は未測定**。agent-model の全セッションで parse 失敗が 0 件だった
  ため、この段は実モデルの出力に対してまだ一度も発動していない。LFM2.5 での測定時に、
  生 parse 成功率と復元後の parse 成功率を分けて読むこと（criteria と集計で分離可能）。
- 復元は json 形式のみ。対象モデルで他形式の構文崩れが支配的になれば別途検討が要る。
- 修復ループ側の未測定分（parse 段階・check 段階の修復効果）は従来どおり未測定のまま。
- ホスト（Eumenes 本体）への統合時に復元段を入れるかは未決定。本書は bench の検証まで。
