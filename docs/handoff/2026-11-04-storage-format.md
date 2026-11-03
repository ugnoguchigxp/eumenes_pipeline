# 保存形式の決定: 生成は minified 可、最終保存は pretty JSON

日付: 2026-11-04（日本時間）
決定: 利用者の指示による。

## 決定

- モデルの生成は、トークン節約のため minified JSON でよい（Wave C の minjson 条件の実測: 出力トークン −36.7%、様式由来の失敗 0件）。
- **最終保存時には JSON を pretty 状態（インデント付き）にして保存する。** 保存形式は読み手（利用者・レビューア）のためのもので、生成の都合に引きずられない。
- この区別は「生成＝モデルの仕事、保存＝コードの仕事」（plan §5）にも沿う。pretty 化は決定的な再直列化であり、モデル呼び出しもトークンも要らない。

## 適用範囲

| 対象 | 扱い |
| --- | --- |
| モデルの生出力・recordings・作業DBの output_text | **不変更**。証拠であり、minified のまま残す（生の parse 成功率などの指標を隠さない） |
| bench の run export（保存物） | 検証を通った定義を構造化データとして同梱し、ファイル自体をインデント付きで書き出す。minified で書かれた定義も、md-yaml / free-md で書かれた定義も、保存形は一律 pretty JSON |
| 本体ホストの永続化（統合時） | `DocumentRecord` に残す定義は pretty JSON で保存する。P2 の adapter 検証ブランチへの申し送り事項 |

## 実装（本日分）

- `bench/export/export.ts`: ExportCell と ExportRepair に `definition`（`AuthoringOutcome` 契約を通った ready の定義のみ。検証を通らなかった出力には保存形は無い＝null）を追加。導出は runner と同じ経路（形式 parser → 契約検証）の再計算で、既存の export の照合（totals / cells / repair の全一致）は不変。
- 検証: 単体テスト（export.test.ts、minified な合成出力→保存形の同値、修復前は null・修復後は保存形あり）。実 run `6b9c91f0`（dev-minjson-1、修復込み）の export で、全60セル中41セルに定義、修復で回復した3セル（music-sfx / ocr-receipt / operate-open-site）に repair 側の定義が入ることを確認。照合は totals / cells / repair 全一致。
- ゲート: `bun run check:all` 278 tests / 0 fail、`bun run bench:verify --db :memory:` 87/87。
