[English](README.md) | [한국어](README.ko.md)

<div align="center">

# Hikoutei

**Google Sheets を利用する MVP 向けの型付きリポジトリと安全な書き込みレイヤー**

<a href="https://www.npmjs.com/package/hikoutei">npm パッケージ</a> ·
<a href="https://github.com/ManddarinShop/Hikoutei/issues">Issues</a> ·
<a href="docs/quick-start.md">クイックスタート</a>

[![npm version](https://img.shields.io/npm/v/hikoutei?style=flat-square)](https://www.npmjs.com/package/hikoutei)
[![license](https://img.shields.io/npm/l/hikoutei?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

Hikoutei は、TypeScript と Node.js のアプリケーションで Google Sheets を
MVP や社内ワークフローの人間向けの画面として利用できるようにします。
アプリケーションは型付きエンティティとローカル SQLite を使い、サービス
アカウントの Google Sheets provider を通して変更を Google Sheets へ非同期に
届けられます。

Hikoutei の対象は意図的に限定されています。汎用データベースの代替、
Prisma/JPA のクローン、汎用 Google Sheets API ラッパーを目的としていません。

## Hikoutei が提供するもの

- エンティティ中心のライフサイクル: 作成、検索、変更、永続化、削除、flush。
- Sheet データに対する型付きフィールドマッピングとランタイム検証。
- リモートのスプレッドシート要求を待たないローカル SQLite の読み取り。
- 人による確認や軽い共同作業に使える非同期 Google Sheets ビュー。
- 予期しないスキーマ変更や新しいデータを上書きする問題への保護。

## インストール

プロジェクトと npm パッケージ名は `hikoutei` です。

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

MikroORM パッケージはルートパッケージの optional peer dependency です。現在の
SQLite provider が内部で利用しますが、ルート public API に MikroORM 型は公開
されません。

## クイックスタート

エンティティ定義と SQLite の lifecycle はルート API だけを使います。Sheet route、
provider credential、provisioning、polling は内部 service bootstrap の責務です。

```ts
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
  },
});

const hikoutei = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
});

const em = hikoutei.em.fork();
const user = em.create(User, { id: "u1", name: "Ada" });
em.persist(user);
await em.flush();

user.name = "Ada Lovelace";
await em.flush();
```

`createTypedSheets()` はローカルの entity table だけを準備し、Google Sheets へ接続
しません。内部 sync service が mapping を登録してタブを provision し、outbound
worker と User_Input polling を開始します。service mode では `flush()` が entity、
canonical state、durable outbox を SQLite transaction としてコミットし、リモート
Sheet への配信は非同期に行います。

## Hikoutei が適しているケース

- スプレッドシートがプロダクトの業務フローの一部である MVP とプロトタイプ。
- 社内ツールと低トラフィックの管理アプリケーション。
- 型付きのアプリケーションデータを保ちながら、Sheets を人が簡単に確認したい
  チーム。
- ローカル SQLite を使うことができ、Sheets の非同期更新を受け入れられるサービス。

## 別のツールを選ぶべきケース

次の要件がある場合は、通常のデータベースと Google API の直接利用を検討してください。

- 複数行または複数サービスにまたがる強いトランザクション。
- 高い書き込みスループット、または多数の同時書き込み。
- 複雑なクエリ、JOIN、レポート処理。
- マルチサーバーまたはマルチリージョンの調整。
- Google Sheets で即時の read-after-write 整合性が必要。
- Google Sheets をアプリケーションの主データベースにする必要がある。

## Google Sheets の設定

Google Sheets の同期は service-side の責務です。推奨経路はサービスアカウントの
`googleSheetsApi` provider で、ひとつのサービスアカウントがタブの provisioning、
outbound effect の書き込み（高速 append、guarded update/delete、レシート、
応答喪失の復旧）、テーブル読み取り、行アンカー、ユーザー編集の観察をすべて
行います。アプリケーションは provider クライアントを import したり、Sheet route
を `createTypedSheets()` に渡したりしません。

1. `https://www.googleapis.com/auth/spreadsheets` スコープを持つ Google Cloud
   サービスアカウントを作成し、対象スプレッドシートをそのメールアドレスに
   **編集者**として共有します。provider がタブ作成、effect 行とレシート記録、
   行アンカー管理を行うため、閲覧者権限では不十分です。Cloud プロジェクトで
   Google Sheets API を有効化します。
2. サービスアカウントキーのファイルパスをサーバーの
   `GOOGLE_APPLICATION_CREDENTIALS` に置き、スプレッドシート ID はコミットされない
   シークレットストアに保管します。キーをブラウザコードや Git に入れないでください。
3. `googleSheetsApi` で内部 sync bootstrap を起動します。登録タブのヘッダーを
   作成・検証した後、outbox 配信と User_Input polling を開始します。

シートの整合性はリクエスト間の Sheet トランザクションから生まれるのではなく、
隠された effect-receipt タブ、effect-id/payload-hash の重複排除、SQLite の
durable outbox、フェンシング、フィールド単位の compare-and-set 証拠、
postcondition 復旧から生まれます。provider は資格情報・スプレッドシート ID・
URL・payload をログに残さず、要求開始間隔をクラスごと（読み取り/書き込み）
1,100ms に調整して Google の quota window を守ります。`flush()` はローカル
コミットのみを意味し、配信は非同期で、すべての書き込みはレシートで記録され、
同じ effect worker が復旧します。

追跡される live シナリオはこの provider で実行されます。
[docs/sync-bulk-write-benchmark.md](docs/sync-bulk-write-benchmark.md) の
10,000 行 append と update/delete の live 証拠も同じ REST 経路です。
`scripts/bench/` の生トランスポート実験はレシート/CAS のない unguarded 経路
なので、worker 経由の測定までは性能値を検証済みと見なさないでください。live
呼び出しは opt-in で、通常の検証は fake provider と SQLite fixture を使います。

従来の Apps Script Gateway と `appsScript`/`googleApiWorker` オプションは削除され、
上記のサービスアカウント provider が唯一の同期経路です。詳しい設定と
トラブルシューティングは [クイックスタート](docs/quick-start.md) を参照してください。

## ドキュメント

- [クイックスタート](docs/quick-start.md) — インストール、ORM lifecycle、service-side sync 設定。
- [アーキテクチャ](docs/architecture.md) — ローカルストアと Sheet ビューの関係。
- [書き込みと同期の流れ](docs/write-and-synchronization-flow.md) — 非同期配信と復旧動作。
- [開発ガイド](docs/development.md) — ローカル開発とテストコマンド。
- [ベンチマーク記録](docs/sync-bulk-write-benchmark.md) — 日付ごとの測定結果と制約。

## 制限事項

- Google Sheets にはクォータ、レイテンシー、API のレート制限があります。
- Sheet の更新は非同期なので、アプリケーションはローカル状態を読み取るべきです。
- SQLite はサービスにローカルなもので、分散調整レイヤーではありません。
- スキーマ変更、手動編集、競合する変更に対する運用方針は、アプリケーション側で
  別途決める必要があります。

## ロードマップ

- Google Sheets から意図的なユーザー編集を取り込む機能を完成させる。
- update/delete の競合処理と表示を改善する。
- レジストリと直接 provider デプロイ用のセットアップツールを追加する。
- 公開パッケージのリリースを安定化する。

現在の作業については [open issues](https://github.com/ManddarinShop/Hikoutei/issues)
を参照してください。

## ライセンス

Hikoutei は [MIT License](LICENSE) の下で公開されています。
