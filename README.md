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

**P0（契約と接続設計）の足場まで。** 記述形式（JSON/YAML）、Routerの利用範囲、定義schemaは未確定で、`src/` の定義と検査は暫定。実モデルでの比較・実測はこれから。計画は [plan.md](plan.md)、現在地と次の作業は [引き継ぎ](docs/handoff/2026-11-03-skeleton.md) を参照。

## 必要なもの

- [Bun](https://bun.sh) 1.4.4（`packageManager` で固定）
- 実モデルを使う実験のみ: Muse Code の `muse` CLI（ログイン済み）。オフラインの検査・テストには不要

## 使い方

```sh
bun install
bun run check:all                 # 型検査（通常・配布ビルド設定）・lint・整形確認・全テスト
bun run bench:catalog             # カタログの写しから部品を棚卸し → data/catalog/
bun run bench:verify --db :memory: # 通信なしの配線検証（定義の検査・モック実行・停止規則・到達ガード）
bun run pack:check                # 配布物の中身の検査（書き込みなし）
bun run pack                      # artifacts/<名前-版-digest>/ に tarball・.sha256・manifest.json を作る
```

テストと `bench:verify` の実行中は、ネットワーク・外部プロセス・実ツールへの到達を到達ガードが塞ぐ。

## 構成

| パス | 内容 |
| --- | --- |
| `src/` | 配布ライブラリ。定義schemaと検査、部品の解決、1手順の実行契約、ホストの接続口（`PipelineHost`・`InferencePort`）。`zod` 以外に依存せず、Bun・Node・DOM・Eumenesをimportしない |
| `bench/` | P0評価専用（配布しない）。カタログの読込みと棚卸し、契約どおりの値を返すモック、実行ドライバー、到達ガード、追記専用の作業用SQLite、`muse exec` の推論口 |
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
