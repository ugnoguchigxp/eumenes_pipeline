# 改善設計書

2026-11-06。2026-11-06のプロジェクト評価（`check:all`、`bench:verify`、カバレッジ、境界probe、作業DBの読み取り）で見つかった改善点を、実装できる単位に分けて設計する。計画の正本は [plan.md](../../plan.md)。§0に、利用者の決定と実施した内容を記録した。§1以降は当初の提案で、§0と食い違う箇所は§0を優先する。

## 0. 2026-11-06 の決定と実施

**前提の訂正**: 設計時は「本体は未接続」としていたが、本体は既に p0-3 を取り込んでいた（本体 commit `bc916e27`、[本体の取込み記録](../../../eumenes/spec/pipeline-p0-3-integration-2026-11-05.md)）。本体の組み立てはbenchとは別物で、次の構成だった。

- 指示文: bundle `pipeline-execution` の profile と skill の本文
- 入力: JSON の利用者メッセージ（原文、資料、回答、カードJSON）
- 解析: `JSON.parse`

**利用者の決定**

| 項目 | 決定 |
| --- | --- |
| 本体の変更（§7-1） | 許可。本流へ反映して使えるようにしてよい |
| 測る物と使う物の揃え方 | 本体の指示文を維持する。ライブラリは厳格な解析・原文の結び付け・実行可否の検査を提供し、benchが本体の指示文を測る。§4のI1（プロンプトを `src/` へ移す案）は採らない |
| 本体の未commit差分 | 重ねて作業し、本体のcommitは保留する |
| CI（§7-5） | 行わない。作成もしない |

**実施した内容**

- **契約版**: p0-3 のままとし、配布版を 0.1.0 にした。本体のbinding契約（`../eumenes/api/domains/capabilities/contracts/bindings.ts:225`）が p0-3 を固定しており、定義のJSON形も変えていないため。§4のp0-4案は採らない。
- **I2（ライブラリ）**: `isRunnable`、`createCatalogView` での絞込み、`checkDefinition` の `component_not_runnable` を実装した。`withheld` は追加していない（不要と判断）。benchの提示24入口とカタログ版 `3be9a125394c` は不変。
- **I3（ライブラリ）**: `bindSourceRequest` を実装した。
- **解析（ライブラリ）**: benchの厳格なJSON読取りを `src/internal/strict-json.ts` へ移し、`parseJsonStrict`・`MAX_JSON_DEPTH` として公開した。
- **I1の代替（bench）**: 条件 `eumenes`（`promptStyle: "eumenes-p0-3"`）を追加した。
  - 本体の指示文は `scripts/extract-eumenes-prompt.ts` で読み取り専用に抽出し、`data/contracts/eumenes-compose-prompt.json` に置く。本体commit `ed0b602e`、指示文のSHA-256は `ab45970740fa…`。
  - カードの写像、JSONメッセージ、出力の読み方（未trim、`status` 必須、原文の結び付け）は本体に合わせた。
  - 本体の修復メッセージは再現していないため、この条件では修復を使えない。
  - 資料の参照と内容は近似である（`bench/format/host-prompt.ts` の冒頭に記載）。
  - 測定（API呼出し）はまだ行っていない。
- **配布物**: `eumenes-pipeline-0.1.0-a859fd16ce46.tgz`。SHA-256は `4c60c46ab77040b3ff4ed23433ca0ae9bd2e689efb8ea1db67da9234d8570f4f`、33ファイル。空の利用側での導入と型検査に成功した。manifestは未commit差分から作ったので `dirty: true` になっている。
- **本体（I4の更新）**: vendorを0.1.0にした。計画出力は `parseJsonStrict` で読み、`ready` 定義は原文に結び付けてから検査する。置換前の文は `pipeline.requestEcho` に残す（先頭500文字と長さ。忘却で消える）。協調作業の下書きは従来どおり、原文が違えば拒否する。詳細は [本体の設計と結果](../../../eumenes/spec/pipeline-0.1.0-hardening-2026-11-06.md)。
- **回帰**: 記録済みのAPI出力（`quality-review-final-{luna,sonnet}`、各24セル）を、変更後のコードで別DBへ再生した。promptDigestの不一致は0件、セルの判定とtotalsは元の記録と完全に一致した（API 0件）。
- **独立レビュー**: 1回実施した。重大な指摘は0件。中〜低の4件を1回で修正した（記録する文の上限、benchの読み方を本体と同じにする、試験の追加、写した本体ファイルのdigest記録）。

**残り**

- `eumenes` 条件での実測（予算判断）。
- I3段階1のbench再採点（`--bind-request`）。
- I5〜I8。
- 本体のcommit・push（利用者の許可待ち）。
- 本体を再起動して0.1.0を読み込ませること（利用者が行う）。

## 1. 目的と範囲

目的は4つ。

1. 評価で測った物と配布する物を一致させる（I1）。
2. 構造検査の穴を、ライブラリ側でも塞ぐ（I2・I3）。
3. 本体接続と新しい未見評価に、実証できる形で進む（I4・I5）。
4. 保守と引き継ぎの負荷を下げる（I6〜I8）。

範囲外: `../eumenes`・`../eumenes_router` の変更（I4は承認後）、Ruri、サーバー操作、`data/source/`・`data/contracts/*.json` の手編集、既存artifactの差し替え、語句やシナリオによる意味判定の追加。

## 2. 現状の根拠

| 観察 | 根拠 |
| --- | --- |
| 全体ゲートは健全 | `check:all` 388件成功・0失敗（47ファイル、約3秒）、`bench:verify --db :memory:` 87/87 |
| カバレッジ | 全体の行92.83%・関数95.71%。`src/` はほぼ100%。`bench/selection/union.ts` 13.78%、`tuning.ts` 29.53% |
| 配布物に組み立て機能がない | `src/` は schema・`checkDefinition`・カタログ解決・型のみ。組み立てプロンプト（`bench/format/prompt.ts`）、カード描画（`bench/formats/cards.ts`）、出力parser（`bench/formats/json.ts`・`strict-json.ts`・`outcome.ts`）はbench専用。`InferencePort` は `src/` 内で未使用。plan §7は「利用に必要なschema・指示等」の公開を予定している |
| 実行可否の検査がホスト任せ | `checkDefinition` は `catalog.resolve` だけに依存する（`src/check.ts:191`）。probeでは `offer: () => true` のとき、`execution: "session"` と `support: "excluded"` の部品が計画に入った |
| 依頼文の書き写しが実際に失敗している | Lunaの機械的失敗2/24は、どちらも `request_mismatch` だけが原因（作業DBの `quality-*-luna` 各session）。`circuit-diagram-record` では依頼を言い換え、`delegated-reading` では末尾に「利用者が渡した資料: 展示メモ.txt（text）」を付け足した |
| 依頼の8000文字上限は本体と同じ | `../eumenes/api/domains/dialogue/contracts/index.ts:9` の `text.trim().max(8000)` と一致する。評価時の「8000文字超を表現できない」という指摘は撤回し、上限は維持する |
| 評価の幅が広い | 24件・各1回のWilson 95%区間。Sonnetの参照適合かつ主judge適切22/24は74.2〜97.7%、Lunaの17/24は50.8〜85.1%。gold監査後の再採点で、参照適合はLuna 14→17、Sonnet 19→23に上がった（既見のdev）。未見の集合は現在ない |
| benchが大きい | `src/` の非試験コード861行に対し、`bench/` は13,806行。`runFormat` は1関数で832行（`bench/format/run.ts:633`） |
| 文書が多く、一部が古い | 追跡中のMarkdownは約342KBで、配布ソース約28KBの約12倍。`plan.md:430-439` はP0a〜P4を未完了、「モック評価器は未実装」のまま |
| 管理の不整合 | `.gitignore:3` は `artifacts/` を除外しているが、9ファイル（証拠tarball 約5.0MBと約4.6MBを含む）を追跡している。commit `d8bf3ad` は286ファイル・+45,069行 |

## 3. 改善項目

| ID | 項目 | 契約への影響 | 承認 | 優先 |
| --- | --- | --- | --- | --- |
| I1 | 組み立てキットを `src/` へ移す | p0-4（公開APIの追加。定義のJSON形は不変） | 不要 | 高 |
| I2 | 実行可否をライブラリ側で多層に検査する | p0-4（`IssueCode` を1つ追加） | 不要 | 高 |
| I3 | 依頼原文をホストが結び付ける | 定義の形は不変。I1のoptionとして追加 | 不要（再採点はAPI 0件）。追加judgeは予算判断 | 高 |
| I4 | 本体接続の最小の縦切り | 本体側の変更 | **必要** | 高（I1・I2の後） |
| I5 | 新しい未見評価 | なし | **必要**（予算・作成者・目標モデル） | 中 |
| I6 | benchの整理 | なし | 撤去範囲だけ確認 | 中 |
| I7 | 文書の整理 | なし | 不要 | 中 |
| I8 | リポジトリ管理と配布README | なし | artifactsの方針のみ | 低 |

## 4. 各項目の設計

### I1. 組み立てキットを配布物へ移す

**目的**: Sonnet 22/24などの成績は、benchのプロンプトとカード描画とparserを含めた測定である。本体が同じ物を再実装すると、測った品質は保証されない。測定対象の経路を、そのまま配布する。

**設計**: `src/compose/` を追加する。外部に依存しない関数だけを置き、`zod` と `src/` 内部以外をimportしない。

| 新しい場所 | 移す内容 | bench側 |
| --- | --- | --- |
| `src/compose/cards.ts` | `renderCardsText`・`summarizeArguments`・`effectsText`（`bench/formats/cards.ts` から無変更で移す） | `renderCardsTextCompact`・`renderCardsJson` は残し、共通部はsrcからimportする |
| `src/compose/prompt.ts` | `SHARED_INSTRUCTIONS`、JSON形式の指示、`buildComposePrompt`（baseline・json） | `buildFormatPrompt` はbaseline・jsonをsrcへ委譲する。他形式と実験条件はbenchに残り、共通指示をsrcからimportする |
| `src/compose/parse.ts` | `parseJsonStrict`・`outcomeFromValue`・`parseAuthoringText`（json）と上限値 | md-yaml・free-mdは `yaml` 依存のためbenchに残し、`outcome` をsrcからimportする |
| `src/compose/compose.ts` | `composeDefinition`（下記） | benchの実行もこの関数を通す |

```ts
export type ProvidedMaterial = { name: string; kind: string };
export type ComposeInput = {
	/** ホストが保持する原文（信頼できる値）。 */
	sourceRequest: string;
	materials: readonly ProvidedMaterial[];
	/** 提示するカードと検査する部品を同じにするため、カードは catalog.offered から作る。 */
	catalog: CatalogView;
};
export type ComposeOptions = {
	/** I3。p0-4の既定はfalse（測定済みの挙動）。 */
	bindSourceRequest?: boolean;
};
export type ComposeResult =
	| { stage: "inference_failed"; prompt: ComposePrompt; inference: InferenceResult }
	| { stage: "parse_failed"; prompt: ComposePrompt; inference: InferenceResult; errors: ParseFailure[] }
	| { stage: "outcome_invalid"; prompt: ComposePrompt; inference: InferenceResult; issues: ValidationIssue[] }
	| { stage: "needs_input" | "unsupported"; prompt: ComposePrompt; inference: InferenceResult; outcome: AuthoringOutcome }
	| {
			stage: "checked";
			prompt: ComposePrompt;
			inference: InferenceResult;
			/** モデルが書いたrequestと、原文との一致。I3で結び付けても記録する。 */
			echo: { written: string; matched: boolean };
			check: CheckResult;
	  };
export function composeDefinition(
	port: InferencePort,
	input: ComposeInput,
	options?: ComposeOptions,
	signal?: CancelSignal,
): Promise<ComposeResult>;
```

- `purpose: "compose"` で `port.complete` を1回だけ呼ぶ。再試行・修復・モデル選択はホストの方針として、関数に入れない。
- `outputSchema` は渡さない。測定済みの条件は通常のJSON生成であり、native schemaによる生成は未測定である。
- `checkDefinition` は常に `{ sourceRequest }` 付きで呼ぶ（3引数の厳格な検査）。
- `DocumentRecord` のdigestはホストが計算する（`src/` は暗号APIに依存しない）。
- `CONTRACT_VERSION` は `p0-4` にする。p0-3のときと同じく、定義のJSON形は変えない。

**受入条件**

1. **プロンプトのバイト同一性**: 移動前に、現行コードで `data/evaluation/quality-review-final-2026-11-05/cases` の24件のpromptDigestを算出し、`data/runs/format/quality-review-final-{luna,sonnet}/requests/` の記録値と一致することを確かめる。一致した値を試験fixtureとして固定し、移動後も一致させる。API 0件。
2. `bench/mock/guard.test.ts` の静的検査（src純度）、`check:all`、`bench:verify --db :memory:` が成功する。
3. `pack:check` と `pack`（新しいdigestの別artifact）が成功し、空の利用側で `composeDefinition` をimportして、偽の `InferencePort` で `checked` まで動く。
4. 既存のp0-3利用側の型を壊さない（export追加と `IssueCode` の拡張だけ）。

**リスク**: 1文字の差で比較可能性が失われる。受入条件1で検出する。

### I2. 実行可否を多層に検査する

**目的**: 除外部品と、初版で扱わない実行種別を計画に入れない。今はホストの `offer` 関数1つに任されている。

**設計**

- `src/catalog.ts` に `isRunnable(record)` を追加する: `record.enabled && record.support !== "excluded" && STEP_EXECUTION_KINDS.includes(record.execution)`。
- `createCatalogView` は `offer(record) && isRunnable(record)` で絞る。ホストの `offer` は絞り込みにだけ使える。外した部品は `withheld: { entry, reasons }[]` として返し、証拠に残す。解決の結果は既存の `component_not_offered`。
- `CatalogView` は公開型で、ホストが自作することもできる。そのため `checkDefinition` は解決後にも `isRunnable` を確かめ、偽なら新しいerror `component_not_runnable` を出す。
- bench側: `bench/catalog/load.ts` はカタログ版を独自の `records.filter(offer)` から計算している。これを `view.offered` から計算するように変え、提示と検査の二重定義をなくす。`bench/catalog/inventory.ts` は既に無効・session・pipeline・範囲外の種別を `excluded` にしているので、提示集合とカタログ版 `3be9a125394c` は変わらない見込み。

**受入条件**: probeの3例（session、excluded、disabled）を `src/check.test.ts` と `src/catalog` の試験に入れる。`bench:catalog` の再生成に差分がなく、`bench:verify` のカタログ版が不変。既存の試験はすべて成功する。

**互換性**: `IssueCode` に値が増えるため、利用側で網羅的にswitchしている箇所はコンパイルエラーになる。p0-4の変更点としてREADMEに書く。

### I3. 依頼原文をホストが結び付ける

**目的**: モデルに原文を書き写させると、意味とは無関係な機械的失敗が起きる（§2のLuna 2件）。原文はホストが持っている。

**設計（段階1、プロンプト不変）**

- `composeDefinition` の `bindSourceRequest: true` のときは、parse後に `definition.request` を `sourceRequest` へ置き換えてから検査する。置き換える前の値は `echo.written` と `echo.matched` に残し、失敗を隠さない。
- これは信頼できる値でフィールドを置き換える構造的な操作であり、意味判定ではない（plan §5に合う）。
- `checkDefinition` と `request_mismatch` はそのまま残す。結び付けを使わないホストや、保存済み定義の再検査で使う。
- benchに既定offの条件 `--bind-request` を追加する。新しいfreeze（コードの識別が変わるため）を作り、元のrecordingを入力とした新しいrun（`parentRunId` は元のrun）として、Luna・Sonnetの24件を再採点する。
- 報告では、機械的有効（予想: Luna 22→24）、`echo.matched` の率、参照適合を分けて示す。新しく有効になった2件の意味判定にはjudgeの再呼出しが要るので、予算判断とする（§7）。既見のdevであり、未見評価とは呼ばない。

**段階2（任意）**: requestを出力から外し、出力トークンと指示を減らす。プロンプトが変わるため、I5の新しい集合でだけ測る。

**上限**: 8000文字は維持する（本体のdialogueと同じ）。本体はtrimした文を保存するので、ホストはその保存値を `sourceRequest` に渡す。

### I4. 本体接続の最小の縦切り（承認後）

[接続案](eumenes-host-integration-2026-11-05.md) を、最小の範囲に絞って実施する。

- **前提**: I1とI2のtarball（p0-4）、本体変更の明示的な許可、試験用の資源。
- **範囲**: 1手順と2手順の短い依頼を、本体の既存launch/adopt経路で実dispatchする。推論はLARMの `InferencePort` から `composeDefinition` を呼ぶ。
- **確認**: 部分成功・確認待ち・失敗を全成功として表示しない。取消と期限。参照の所有とdigest。
- **含めないこと**: 新しい実行ループ、第二の状態台帳、依頼ごとの定義のtoolchain化、サーバーの自動操作。

**受入条件**: 接続案の「既存のpipelines／agent-runtime試験」の行と、本体の該当domain検査。実行するのは利用者が許可した範囲だけ。

### I5. 新しい未見評価（承認後）

既存の基盤（`bench:infer`、`bench:judge:prepare --freeze`、freeze、予算台帳、replay bundle）をそのまま使う。新しい評価ツールは作らない。

| 項目 | 設計 |
| --- | --- |
| 件数 | 80件。p≈0.85でWilson 95%の半幅は約±8pt（p≈0.7で約±10pt） |
| 構成 | pipeline 60・needs_input 10・unsupported 10程度。fixture依存は別に集計し、30%以下を目安にする |
| 作成 | 利用者または第三者が作る。実装担当AIは作成と調整に関わらない。freeze後にプロンプトや条件を変えない |
| gold | 生成前にgoldだけで監査して固定する。生成後に直す場合は、事前固定版を見出しの成績とし、修正版は別に示す |
| 試行 | 各モデル・各ケース3回。平均とケースごとの一貫性を出す |
| 判定 | 主判定は生成と別系統のモデル。無作為の20%を利用者が人手でラベル付けし、judgeとの一致率（κ）を出す |
| 比較 | 事前に登録した対だけを比べる（例: 目標モデル対Sonnet、I3段階2の有無）。対応のある比較（McNemar、paired bootstrap）を使う |
| 予算 | 前回は319要求で費用上限5.204023 USD（1要求あたり約0.016 USD）。80件×3回×2モデル＝生成480件で、judgeの比が前回と同じなら約35〜40 USDの概算。10件の試行で再見積りする。現在の10 USD承認の残りでは足りない |

### I6. benchの整理

**目的**: 未採用の条件と巨大な関数が、変更の費用と誤りの余地を増やしている。

**条件の棚卸し**（記録上の判定。最終の扱いは実施時に表で確定する）:

| 条件 | 記録 | 提案 |
| --- | --- | --- |
| `threshold`・`--triage` | 不採用（`2026-11-04-accuracy-2.md`） | 撤去 |
| `--staged`・`--coverage-repair` | 不採用（`2026-11-04-staged.md`） | 撤去 |
| `--normalize-ids` | 採用（accuracy-1）だが、最終評価では既定off | 判定。残すなら既定にするか、I1へ取り込む |
| `--repair` | Wave Cでbench機構として採用。最終評価ではoff、API修復は各1回で確認済み | 判定。ホストの修復方針の候補として残すか |
| `compact`・`oneshot`・`minjson`・`--restore-syntax` | 実験条件として残置 | 計画中の測定に要らなければ撤去 |
| `--candidates`・union・tuning | subset推奨として採用（accuracy-3）。最終は全カード提示 | 判定。残すなら `union.ts`・`tuning.ts` に試験を追加する |
| md-yaml・free-md形式 | JSONを基準に選定済み | 判定。撤去すると `yaml` devDependencyも外せる |

撤去後の旧runは、当時のcommit（例: `6640de2`、`0a28a55`）と保存済みのreplay bundleで再現する。この方針を `docs/evaluation.md` に明記する。

**`runFormat` の分割**: 準備（ケース・カタログ・freezeの読込み）、セルの実行（既存の `runCell`）、修復（既存の `runRepair`）、集計、記録の書出しに分け、どの関数も150行以下にする。

**受入条件**: 分割の前後で、記録済みsessionを別の作業DBで再生する。run ID以外の `summary.json` とscore行が一致し、API 0件。`check:all` と `bench:verify` が成功する。

### I7. 文書の整理

- `docs/STATUS.md`（1ページ）を作る。内容は契約版、最新のtarballとSHA-256、最新の検証結果、未決事項、判断待ち。AGENTS.md「目的と現在地」とREADME「状態」は、要約とこのページへのリンクにする。
- `plan.md` §13のチェック表を現状に合わせる。「モック評価器は未実装」は当時の記録として明示する。
- `docs/handoff/README.md` に、各handoffの結論を1行ずつ並べた索引を作る。既存のリンクを壊さないよう、ファイルは移動しない。
- P0a〜P4、Q01〜Q18、dev/holdout、ready/partial/fixture などの用語集を、STATUSに1つだけ置く。

### I8. リポジトリ管理と配布README

- **artifacts**: 追跡する意図を明示する。配布tarballは本体の `vendor/` に使うので、`.gitignore` に `!artifacts/eumenes-pipeline-*/` の否定規則を置く。証拠tarballは今後、SHA-256とmanifestだけを追跡し、本体を別の保存先に置く案を判断事項とする（既存の履歴は変えない）。
- **README**: `bun pm pack` は直下の `README.md` を同梱する。冒頭を利用側向け（導入、`composeDefinition`・`checkDefinition`、p0-4の変更点、ホストの責務）にし、API検証とbenchの手順は `docs/evaluation.md` へ移す。
- **commitの粒度**: commitは依頼されたときだけ行う。その際は、改善項目ID1つにつき1 commitとする。

## 5. 実施順序

```
段階A（承認不要・API 0件）
  I2 ──► I1 ──► I3段階1（再採点）──► I6 ──► I7 ──► I8
段階B（承認後）
  I4（p0-4 tarballが前提）
  I5（I3段階1の結果を比較対象に登録）
```

- I2を先にすると、I1の `composeDefinition` が最初から多層の検査を使える。
- I6はI1の後にする。I1で移した部品をbenchがimportする形に揃えてから撤去すると、差分が小さい。
- 各変更の後に `bun run check:all` と `bun run bench:verify --db :memory:` を通す。公開APIを変えるI1とI2では `pack:check` と `pack` を通す。

## 6. 検証と記録の規則

- 新しい条件と再採点は新しいrunとし、`parentRunId` を付ける。完了した試行は書き換えない。
- 取得できないtoken・費用はnullのままにする。fixture依存とpartialの結果は、readyと分けて報告する。
- 既見のdevでの再採点を「未見」と呼ばない。I5の結果だけを新しい未見の評価として扱う。
- 正解・模範手順を、`composeDefinition`・モック・judgeの入力へ入れない。

## 7. 利用者の判断事項

1. **I4**: 本体（`../eumenes`）の変更を許可するか。許可する範囲（vendor、`api/application/pipelines/`、agent-runtimeとの接続、試験）。→ 2026-11-06に許可された（§0）。
2. **目標モデル**: `src/index.ts` は「弱い目標モデルでの最終確認が未了」としている。実運用で使うモデルはどれか。I5の比較対象になる。
3. **I5の作成と人手判定**: 評価ケースを誰が作るか。20%の人手ラベルを付けられるか。
4. **予算**: I3段階1の追加judge（数件）と、I5（概算35〜40 USD、試行後に再見積り）。
5. **CI**: 2026-11-06に「行わない」と決定した。作成もしない。
6. **I6の撤去範囲**: 旧条件を現行コードで再生できなくなることを受け入れるか（旧runは当時のcommitとbundleで再現する）。
7. **I8**: 証拠tarballを今後も追跡するか。

## 8. 完了の定義

段階Aの完了条件:

- I1・I2・I3段階1・I6・I7・I8が、上記の受入条件を満たしている。
- `check:all` と `bench:verify --db :memory:` が成功している。
- p0-4のtarballが空の利用側で動作している。
- `docs/STATUS.md` に結果が転記されている。

段階Bの完了は、利用者が許可した範囲での本体受入と、I5の事前登録どおりの報告とする。
