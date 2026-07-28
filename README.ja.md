[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

<div align="center">

# Hikoutei

**Google Sheets を利用する MVP 向けの型付きリポジトリと安全な書き込みレイヤー**

<a href="https://www.npmjs.com/package/typed-sheets">npm</a> ·
<a href="https://github.com/ManddarinShop/google-sheets-orm/issues">Issues</a> ·
<a href="apps-script/gateway/Code.gs">Apps Script Gateway</a>

[![npm version](https://img.shields.io/npm/v/typed-sheets?style=flat-square)](https://www.npmjs.com/package/typed-sheets)
[![license](https://img.shields.io/npm/l/typed-sheets?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

> [!NOTE]
> **Hikoutei** はプロジェクトブランドです。公開パッケージの名前が
> 安定するまで、npm パッケージは現在 `typed-sheets` として公開します。

Hikoutei は、ローカル SQLite を基準ストアとして利用する、TypeScript
アプリケーション向けのエンティティ指向リポジトリ API を提供します。
Google Sheets は、人間が確認できる非同期プロジェクションとして利用します。
MVP、社内ツール、プロトタイプ、低トラフィックの管理ツールなど、
スプレッドシートがプロダクトの一部になる環境を対象にしています。

Hikoutei は汎用データベースの代替、Prisma/JPA のクローン、汎用 Google
Sheets API ラッパーを目的としていません。

## 適しているケース

- アプリケーションが TypeScript/Node.js サーバーで動作する
- SQLite をローカルの基準ストアとして利用できる
- ユーザーが Google Sheets のデータを確認、または時々編集する
- 結果整合性を許容できる
- MVP、社内ツール、プロトタイプ、低トラフィックの管理ツールである

## 適していないケース

次の要件がある場合は、通常のデータベースと Google API の直接利用を
検討してください。

- 複数行または複数サービスにまたがる強いトランザクション
- 高い書き込みスループット、または多数の同時書き込み
- 複雑な SQL クエリ、JOIN、レポート処理
- マルチリージョンまたはマルチサーバーの調整
- Google Sheets での即時 read-after-write 整合性
- Google Sheets を主データベースとして利用する

## ドキュメント

- [アーキテクチャ](docs/architecture.md)
- [クイックスタート](docs/quick-start.md)
- [書き込みと同期の流れ](docs/write-and-synchronization-flow.md)
- [開発ガイド](docs/development.md)
- [ベンチマークの全履歴](docs/sync-bulk-write-benchmark.md)

## Google Sheets Gateway

[`apps-script/gateway/Code.gs`](apps-script/gateway/Code.gs) を Google Apps
Script Web App としてデプロイします。提供される Gateway は意図的に薄く
設計されています。

1. 署名された operation envelope を検証する
2. operation 契約を検証する
3. 許可された Sheet 操作を実行する
4. 構造化された結果をサーバーワーカーへ返す

基準状態、outbox の判断、リトライポリシー、reconciliation（不整合の補正）、
エンティティ評価は Node/SQLite 側の Hikoutei が担当します。Gateway の共有
シークレットをブラウザコードに入れたり、Git にコミットしたりしないでください。

プロビジョニングは明示的に行います。まずローカル SQLite レジストリを
初期化し、その後 operation ベースの Gateway を通して
`provisionRegisteredSyncSheets()` を使用してください。

## 以前の経路と現在の経路

現在の設計は経路単位で発展したものです。過去のすべての beta バージョンと
直接比較できることを保証するものではありません。

| 領域 | 以前の同期経路 | Hikoutei の現在の経路 |
| --- | --- | --- |
| 基準状態 | Sheet メタデータとリモート検証を混在 | SQLite を基準ストアとして利用 |
| 書き込み経路 | effect ごとのメタデータ、snapshot、CAS、receipt、postcondition | SQLite durable outbox とバッチ fast append |
| Gateway | より多くの同期判断を Apps Script で実行 | 薄い署名付き operation dispatcher |
| 補正 | 初回書き込みと補正処理が同じ経路で競合 | reconciliation を独立した安全網として分離 |
| ポーリング | 完全な snapshot とメタデータ中心のスキャン | バッチ values-only 読み取り後にローカル比較 |
| 公開 API | 低レベルの insert/update/delete 中心 | `persist`、変更、`flush`、`remove` のエンティティライフサイクル |

現在の設計では、応答が失われた場合にリモート書き込みの exactly-once を
証明しようとするのではなく、冪等な effect と reconciliation による
at-least-once 配信を選択します。

## パフォーマンス概要

以下はリポジトリで測定したベンチマークです。すべての Google Sheets 環境に
適用される普遍的な保証ではありません。

### 軽量ポーリングの改善

同じ 66 行の運用データ形状を、以前の完全 snapshot ポーリングと現在の
values-only ポーリングで測定しました。

| 経路 | 経過時間 | リモート読み取り | 結果 |
| --- | ---: | ---: | --- |
| 以前の完全 snapshot ポーリング | 27,652 ms | — | 基準値 |
| 現在の初回軽量ポーリング | 2,109 ms | 573 ms | 約 13 倍高速 |
| 現在の定常状態ポーリング | 2,240 ms | 530 ms | 約 12 倍高速 |

現在のポーリングは 3 つの `getValues()` 操作を 1 つの署名付きリクエストに
まとめ、結果をローカルで比較します。ユーザーの編集を canonical write に
評価する処理までは含みません。

### Fast append の処理能力

新しい Sheet で reconciliation を無効にし、実際のライブラリインターフェース
から 6 列の synthetic row 370 件を 1 リクエストで送信しました。

| 行数 | 経過時間 | 行/秒 | セル/秒 | 結果 |
| ---: | ---: | ---: | ---: | --- |
| 20 | 2,275 ms | 8.79 | 52.75 | applied |
| 100 | 2,729 ms | 36.64 | 219.86 | applied |
| 370 | 3,792 ms | 97.57 | 585.44 | applied |

測定した 3 段階で合計 490 行がすべて正常に処理されました。この測定は
純粋な fast append の結果であり、SQLite outbox drain、reconciliation、
postcondition 検証、delete 処理は含みません。

### 運用経路の全体測定

実際の `User`/`Order`/`OrderItem` サーバーフローでは、Order 370 件と
OrderItem 740 件、合計 1,110 行の反映に 36,865 ms かかり、失敗した effect
はありませんでした。最大のコストはローカル ORM flush や `setValues()`
自体ではなく、HTTP/Apps Script dispatch と range lookup でした。

詳しい日付別の結果は
[`docs/sync-bulk-write-benchmark.md`](docs/sync-bulk-write-benchmark.md) を
参照してください。

## 制限事項

- Google Sheets は結果整合性であり、quota とレイテンシーの影響を受けます。
- SQLite が基準ストアであり、マルチサーバー調整レイヤーではありません。
- `_version` と effect 状態は stale write 保護を提供しますが、分散トランザクション
  ではありません。
- ユーザー編集、update/delete の競合処理、reconciliation には別途運用ポリシーが必要です。
- Apps Script の実行制限と応答欠落は、ワーカーが復旧する必要のある外部障害要因です。
- 高スループットのトランザクション処理には適していません。

## ロードマップ

- `typed-sheets` beta 互換パスを維持しながら `Hikoutei` の公開ブランドを安定化
- `onEdit` と軽量ポーリングによるユーザー編集収集契約を完成
- update/delete effect と競合表示を強化
- レジストリと Apps Script デプロイ用の setup CLI を追加
- 運用同期契約を検証した後に stable パッケージを公開

実装メモと現在の課題は
[open issues](https://github.com/ManddarinShop/google-sheets-orm/issues) を
参照してください。

## 追加ドキュメント

- [MikroORM adapter と entity facade](docs/mikro-orm-adapter-spike.md)
- [SQL レイヤー計画](docs/sql-layer-plan.md)
- [Task queue 書き込みモデル](docs/task-queue-write-model.md)
- [同期オブザーバビリティ](docs/sync-observability.md)
- [Apps Script gateway ソース](apps-script/gateway/Code.gs)

## ライセンス

Hikoutei は [MIT License](LICENSE) で公開されています。
