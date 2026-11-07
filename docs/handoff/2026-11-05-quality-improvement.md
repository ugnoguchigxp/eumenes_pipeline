# 品質改善の実装記録

日付: 2026-11-05 日本時間。計画: [品質改善実装計画](../plans/quality-improvement-2026-11-05.md)。実装前snapshot: `6640de2`。本リポジトリ内の技術品質は正式80.9点を確認した。最終結果は [再評価報告](../reviews/2026-11-05-quality-reevaluation/report.md) を正本とし、以下の途中経過は当時の状態として保持する。

## 完了した検証

- Q01: 外部tokenizerを前提とした2件の試験を一時fixtureと明示的envへ変更。通常の未設定時のnullと到達ガードは維持した。
- Q02: JSONのown property生成と状態判別を修正。特殊キー、エスケープ、継承判別、100個の生成値と標準parserの差分を確認した。修正前の反例失敗を保存した。
- Q01とQ02の全体ゲート: 333件成功、0失敗。`bench:verify` 87件成功。ログは `data/work/quality-improvement-2026-11-05/`。
- Q03の実装: runに実行コードのcontent identityを記録。formatとselectionのケース本文とhashを実行時に固定。exportは元のケースを使用し、明示した別ケース集合とのdriftを拒否する。旧runは `casesPinned: false` として扱う。関連30件成功。
- Q04の実装: 評価側のrole graphと配送制約を追加。同じ入口の反復、別のstep ID、代替入口、誤配線、未配送を検査する。江戸のdevケースの関係を明示し、旧来の反例が合格しないことを確認。scorerをv2とした。関連50件成功。
- Q14の基盤: 共通InferencePort、明示した公式endpoint、キー別名、保守的な共通予算、実API証跡、再生用manifestとCLIを実装。単体17件と記録再生を含む結合48件成功。
- この時点の全体ゲート: 360件成功、0失敗、型とlintと整形も成功。

## API予算と疎通

利用者の合計上限は10 USD。全providerと工程が `data/policies/api-validation-2026-11-05.json` のbudget IDを共有する。実行上限8.5 USDとし、1.5 USDを余裕として残す。API予算のreservedとsettledは追記専用で、失敗や中断でusageが不明な場合は予約を保持する。費用上限の計算値と実請求を区別し、実請求は取得不能ならnullに保つ。

- OpenAI疎通run: `3af86679-8b59-453f-b81f-c785760f01b2`。`gpt-6-luna`、成功。
- Claude疎通run: `38e63aae-7ba8-4c41-8d83-1aeff156e3bc`。`claude-haiku-5-5`、成功。
- 合成の短い入力だけを各1件送信。この時点の共有台帳の費用上限は0.000101 USD。実請求額はnull。
- 生応答と照合情報: `data/runs/format/quality-smoke-<provider>/api-evidence/<runId>/`。正解やAPIキーは送信資料とログへ含めない。キーは明示zshログイン環境から継承した。

## 残作業

- Q03: 追加のselection CLIへのケース固定の展開、証拠bundleの独立再計算。
- Q04からQ07: 意味評価と正解監査、独立再生、凍結manifest、新しい評価集合の保護。
- Q08からQ13: 文書統一、必要なコード整理、境界と故障注入、CIと配布、性能予算。
- Q14: dev校正と、新しい未見集合での両APIと交差judgeの測定。疎通成功だけで品質受入とはしない。
- Q15とQ16: 本体の実経路、許可されたツールと画面、導入と更新と復帰の確認。本体側は読み取り調査のみで、まだ変更していない。
- Q17: 実施結果だけを根拠とした同一rubricによる再評価。目標83.3を実績として転記しない。
- Q18: 許可された利用担当の効果と継続利用。未実施の証拠は未確認を維持する。

commitとpushは実行していない。既存の計画書差分と評価基準の台帳を保持している。

## ブランチの棚卸し（利用者の指摘後）

- `git fetch origin '+refs/heads/*:refs/remotes/origin/*'` で全リモートブランチを取得して確認。pipelineの `main`、`work/p0-continuation`、`origin/main` はすべて `6640de20103626039b7f87f7a4849005657bc2aa`。左右の未取込みcommit数は両方0。作業treeは一つ。未コミットの改善差分は保持した。
- 本体 `../eumenes` は読み取りのみ確認。引き継ぎP2の `work/pipeline-adapter-verify` / `9101985` はローカルref・object・リモートheadに無い。記録された `~/workspace/dev/eumenes` も存在しない。実装が存在しなかったとは断定できない。
- 本体の他ブランチについて `api/application/pipelines`、`vendor/pipeline`、依存定義のmain以降の差分を確認したが、当該adapterの先行実装は確認できなかった。
- 本体接続Q15は元実装の取得を先行条件にする。利用者から「無いなら問題ない」と回答があり、旧ブランチ不在を前提に進める。pipeline側の独立した改善は継続可能。確認前にadapterを新規実装しない。
- この時点の追加ゲート: 意味judgeの入力隔離と整合性試験を含め362件成功、0失敗、型・lint・整形成功（`q05-check.log`）。

## 追加の実装と検証

- 内部契約はp0-3。修正版Zod 4.6.7に更新し、直接依存を正確な版へ固定。既知のcollection過大入力の修正を確認し、更新後のauditは0件。DOM型を要求する内部型は公開validatorから切り離し、parse/safeParseの口にした。配布consumerの要件は緩めていない。
- 原文をホストのsourceRequestと照合できる検査口を追加し、この口では検査不能の引数も停止する。引数の循環、過大深さ・要素数、非有限数、アクセサーを拒否して複製する。語句やシナリオに応じた意味判定は追加していない。
- 追加selection経路もcase本文とhashを実行前に固定する。exportの全不整合を終了コードへ反映した。証拠bundleは元ケースとコードと記録を含み、WALのraw serializeが独立に開けない不具合をVACUUM INTOで修正した。別の一時ディレクトリでAPI0件の再計算一致を確認。
- DB版1から2への移行は完了済みrunを保持し、複数接続の共通予算を確認。遅延embedのabortとredirect拒否、開始前期限切れのdispatch0件を確認。
- 現時点の全体ゲートは371件成功、0失敗。通信なしの配線は87/87。APIキーとtokenizer設定を渡さない別のローカルコピーでも全体検査・配線・packが成功した。最初のコピーでは元のignore/lint設定の転送漏れで外部依存を検査して失敗したため、元設定を正しくコピーして再確認した。プロジェクトの検査条件は変更していない。
- 独立した作業コピーとのtarball SHA-256は一致。配布物29ファイル、sourceDigest 34aa1dda7a2b、tarball SHA-256 72c669792bb01a647be03f879290615f010573b3d72f3d07dfef9c85a06e9f65。現行のpackも空のconsumerで導入・ES2022のみの型・実行を確認。
- pure構造検査は実カタログ24入口、1/8手順、短い/上限のtask、各1000回。p95は最大約0.0074msで、事前の5ms枠内。推論や実ツールの時間とは区別する。
- 利用者の指定によりCI追加・実行は除外。途中のworkflowは削除済み。CI成功を再評価の根拠にしない。

## API評価の条件固定

- 元のHaikuの判定は誤選択や必要依存の欠落を見逃した。Lunaも校正で判定不能と誤った不合格が残った。これらを主判定として採用していない。
- 利用者が3つの提示した基準判定を妥当と確認した。追加1件は作者AIの妥当別解。Sonnetは4/4一致、ただし小さい校正集合で一般精度を保証しない。
- 最終条件は24件、各provider1回。Luna低推論とSonnet adaptive、全カード提示、JSON通常生成、修復等はoff。両者の出力を両者で評価し、Sonnetを校正済み主判定、Lunaを診断用の交差判定とする。native schemaはjudge側だけで、native compositionは受入未測定。
- 最終source identity: ad7165eddb744ef2be27e28879b585df0a3a5fbb06f58b3611eddbe7ffd56f95。
- ケースdigest: 2450e907dba157629ec8c2451b8a2ebef9432b0a52886226d2e99a887c2db9b4。freeze digest: 445544683dc316b86caf42d6da7e8dad0e66b64c4c2e37c867feebf61f522e42。
- 新規24件は18 pipeline、3 needs_input、3 unsupported。参照上の対象は提示24入口、有効分母は26件。作者AIは内容を見ているので作者に対する盲検とは呼ばない。旧holdout116件のうち40件という歴史的呼称は既見として保存する。
- 凍結後に条件や件数を成績に合わせて追加しない。生成48件はAPIとしては全件完了。構造合格はLuna 14/24、Sonnet 19/24。API成功、構造判定、意味判定、実ツール成功を別に扱う。交差判定の実行中。
- 全APIが同じbudget IDを共有。Sonnet生成後の費用上限値は1.388145 USD、実請求はnull。最終集計で以後のjudgeも含めて更新する。

本体の実経路については[接続案](../plans/eumenes-host-integration-2026-11-05.md)を用意した。実装や稼働環境への作用はまだ行っていない。

## 最終状態（今回の完了範囲）

- 最新の利用者指定は「このプロジェクトに閉じた80点超えを先に達成」。本体変更・正式取込み、CI、利用者の実利用観察は行っていない。
- 技術品質はrubric1.1.0/libraryの同じ30項目で正式80.9点、確認率100%、除外0、信頼度Medium。基準の暫定57.4点は保持した。共通29項目でも81.1点。将来性の正式点は保留、確認率65%。実装と評価は同じ担当で、独立人手レビューではない。
- 最終source identityは `d8ac16d99861d43ae8be84f19ef82eef3d7242447b07bdba6b0eafaf9dd0ba25`。freezeは `4e3ba7ebfb7b44531f4bc46c231a80b1f3eb6f1975a572c96f89a0815e47c846`。参照は `data/evaluation/quality-finalized-2026-11-05/`。
- 生成時の入力と出力は変更せず、4つの過剰な最終配送goldをgold-only監査で修正した。judgeの入口/bundle混同をv3へ修正し、公開契約と機械的名前解決結果を追加した。元の判定と新判定を別保存。修正後のケースはすべて既見devであり、2回目の未見評価とは呼ばない。
- v3の7対照はSonnet7/7、Luna6/7。主意味判定はSonnet、Lunaは診断用。24件ずつの監査後参照適合はLuna17/24、Sonnet23/24。主意味適切は19/24、23/24。参照と主意味の両方は17/24、22/24。曖昧なgold2件は無理に変更していない。
- 制御した未知参照の破損に対し、両APIの実修復を各1回確認した。自然発生の失敗率とは別の証拠で、追加生成サンプリングには使っていない。
- 混在sessionでlegacy生成とAPI修復を一緒に使うと由来判定が過剰拒否する不具合を修正した。API記録には明示markerを加え、由来欠落時の格下げを拒否。outputSchemaがdigestに含まれなかった不備も修正した。旧API記録はunknown schemaを明示拒否し、元の不変runのrequest hashとtrial output hashを照合して、新規sessionのみにschema識別を復元した。移行run `f996bd70-e837-4427-907f-b2d30f0934c9`、派生146件・legacy原文コピー2件、HTTP0。元記録は上書きしていない。
- 最新の全体検査は378件成功・0失敗。配線87/87。新しい空のコピーでも同じ全体検査・配線・pack:check・pack・空のconsumerが成功。元のignore設定と制約をそのまま使った。
- 全実HTTP要求319件（生成66、評価251、修復2）、未精算0。共通費用上限5.204023 USD、実請求null。請求実額と上限の達成は区別した。これ以上のAPI呼出しは行っていない。
- 現行tarballは `artifacts/eumenes-pipeline-0.0.0-32f778cb14b4/eumenes-pipeline-0.0.0-32f778cb14b4.tgz`。SHA-256 `9ba750c488610ad39d280931e861e6d8fb6a6e44f118ce5900cb80ce8fcc62c9`、別のソースコピーでも一致。以前の配布物も保持する。
- 完全な再現用一式は `artifacts/quality-evidence-2026-11-05-d8ac16d99861/standalone-evidence.tar.gz`、SHA-256 `f16c6410c3ff4c8a55fd405e37834b4fdf08fd121154d82e549815115eb82945`。2091ファイル、約4.6MB。元DBに依存せず、別の場所で48件と意味評価の再集計が一致した。比較除外は新規run IDのみ。API0件。
- 再現bundleのルートには生成JSONがあり、ソース用format:checkでは当該2ファイルの整形違反となった。生成証拠は変更せず、ソースだけの別コピーで全体ゲートを実行し成功した。比較の初回不一致もrun IDだけだったため、対象フィールドを明示して再照合し、判定差は0と確認した。
- 実装は未コミット。今回の改善に新しいcommit/pushはしていない。配布manifestのdirty表示を残し、content identityで評価対象を識別する。次段階は本体の明示的な実装依頼後に接続案を実施する。

## 追加コードレビュー

利用者の「コードレビューし、改善点がなくなるまで改善」に対応し、[レビュー記録](../reviews/2026-11-05-code-review/report.md) の7件を修正した。388件の全試験、87件の配線、空のソースコピーの検査とpack:check、保存済み48件の強化したAPI由来照合、別ディレクトリの独立再集計が成功。追加の有料HTTP呼出しは0件。

最新source identityは `74a4ba53967566892d27aa7feab6d08cf20a4ac7ae9fb2a6ff61eda9f120bdb8`、freezeは `9a0a4d819d27751efb60998cab9c9b0f4a3157217a2fd4cef3ed2816bb085fa6`。`data/evaluation/quality-review-final-2026-11-05/`を参照する。前の80.9点台帳と元実測は上書きせず保持する。現在の範囲で未解決の具体的指摘は無いが、第三者・実ホスト・実ツールの検証を行ったとは扱わない。

## 2026-11-07：評価対象の版固定とrunnerの整理

利用者の指定によりPipelineリポジトリだけを改修する。本体・Router・稼働設定・サーバー・通知は変更しない。

本体の続行検証で計画revision 2が使われている一方、benchの既定snapshotはrevision 1だったため再抽出した。本体 `fb8eac06ba1e32891c51355c4e067d678e7fd555` のcleanなbundleから `--toolchain-revision toolchain:pipeline.execute@2` を指定し、`data/contracts/eumenes-compose-prompt-v2.json` を生成した。指示文SHA-256は `c6ae5096a78b6c5856a08589084eb35472670e0e9441dc990dee7936b1316dc5`。旧snapshotは上書きしていない。

benchの `eumenes` 条件でsnapshotと期待revisionを明示指定できるようにし、freezeには指示文だけでなくsnapshot全体のdigestと出所も含める。使用した本文は作業DBと証拠bundleへ保存し、外部ファイルの後日の変更から再生を独立させる。入力の近似範囲もrunに明記する。新しい未使用ケースの実API評価、本体の通常設定での反復受入、実成果物の品質測定は未実施であり、過去24件の成績は更新しない。

runnerは入力準備・実行と記録・集計と書出しに分離した。旧条件と採点基準は保持し、保存済みのLuna/Sonnet各24出力を一時的な別DBへ再生して、変更前後のsummary・ケース結果・各240採点行の一致を確認した。`check:all` は423件成功・0失敗、`bench:verify --db :memory:` は87/87・外部到達0件。旧revision 1を使った証拠bundleを別ディレクトリへ作り、固定依存の導入後に同梱CLIで再生して `equal: true` を確認した。実API呼出しは0件。再生の確認は実モデルの新規測定ではない。詳細な指定手順と制限は [評価手順](../evaluation.md#評価する版の指定と固定2026-11-07) を参照する。

## 2026-11-07 全体コードレビュー後の修正

[全体レビュー](../reviews/2026-11-07-code-review/report.md)で4件を確認し修正した。引数コピーが非列挙toJSONを呼ぶ問題、bundleに元runと違うcatalog/契約/fixtureを混ぜられる問題、抽出時にfile本文をtrimして出所hashがずれる問題、本体条件のjudgeだけが原文結合前を評価する問題である。LLMの意味判断は変更していない。

出所hashを正すためrevision 2のsnapshotを同じCLIで再抽出した。参照元本体は `fb8eac06ba1e32891c51355c4e067d678e7fd555` のまま、指示文digestも `c6ae5096a78b6c5856a08589084eb35472670e0e9441dc990dee7936b1316dc5` のまま。本体参照二ファイルの記録hashはGitの実バイトと一致した。旧snapshotと過去API記録・goldは保持している。

全体428件・配線87件が成功。保存済48出力・480採点行と、過去judge96要求のschema込み再計算digestが一致した。配布33ファイルと空consumerを確認した新tarは `artifacts/eumenes-pipeline-0.1.0-ce2eb2248bc6/eumenes-pipeline-0.1.0-ce2eb2248bc6.tgz`、SHA-256 `678a9a1774e3df369dd895b6e1816d962261603ce374f205859fd1af95408468`。本体へは配置していない。実API呼出し0件。通常設定の本体受入と新しい未見品質実測は残作業である。
