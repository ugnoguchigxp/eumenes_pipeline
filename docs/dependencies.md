# 依存と配布の確認

2026-11-05。公開APIと配布物の検証は品質改善記録を参照する。新しい依存は追加していない。直接依存は正確な版で固定し、lockfileを使って復元する。Bunパッケージは公開から7日以上経過した版だけを導入する。

| 依存 | 版 | 用途 | パッケージのライセンス表示 |
| --- | --- | --- | --- |
| zod | 4.6.7 | 実行時の構造検査 | MIT、LICENSEあり |
| yaml | 2.9.1 | benchの形式比較 | ISC、LICENSEあり |
| jsonrepair | 3.15.0 | benchの明示的な構文復元 | ISC、LICENSE.mdあり |
| typescript | 7.0.2 | 型と配布ビルド | Apache-2.0、LICENSEあり |
| oxlint | 1.86.0 | 開発時の検査 | MIT、LICENSEあり |
| @types/bun | 1.3.14 | benchとscriptの型 | MIT、LICENSEあり |
| eumenes_router | 0.0.1の固定tarball | benchの選択比較 | MIT、LICENSEあり |

元のZod 4.4.3は、制約付きcollectionの過大入力による問題の対象だった。[公式修正](https://github.com/colinhacks/zod/commit/a0ebf97)と[脆弱性情報](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)を確認し、2026-10-12公開の4.6.7へ更新した。更新後の `bun audit --json` は指摘0件だった。監査結果は確認時点の既知情報であり、未知の問題がないという保証ではない。

この更新で内部型のURL参照がES2022だけのconsumerを壊したため、公開validatorは `parse` / `safeParse` の型へ限定した。DOMやBunの型をconsumerへ追加せず、配布物を空のconsumerへ導入して型と実行を確認する。定義のJSON形は維持し、公開API変更をp0-3として記録する。

tarballはdistのESM・型宣言、package.json、README、MIT LICENSEだけを含む。bench、評価用DB・契約・ケース・API記録・キーは含めない。実行時依存Zodは別パッケージとして解決し、そのLICENSEを保持する。dev依存Routerと評価用snapshotを配布物へ混ぜないことを梱包検査と独立consumerで確認する。

利用者の指定により、CIの追加と実行は今回の範囲から外した。追加途中だったworkflowは削除済み。依存復元、型、lint、整形、単体・結合試験、通信なしの配線確認、梱包と独立consumerの検証はローカルで行う。再評価ではCIの存在や成功を加点根拠にしない。
