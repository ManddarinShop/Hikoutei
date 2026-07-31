[English](README.md) | [한국어](README.ko.md)

<div align="center">

# Hikoutei

**Google Sheets を利用する MVP 向けの型付きリポジトリと安全な書き込みレイヤー**

<a href="https://www.npmjs.com/package/hikoutei">npm パッケージ</a> ·
<a href="https://github.com/ManddarinShop/Hikoutei/issues">Issues</a> ·
<a href="apps-script/gateway/Code.gs">Apps Script Gateway</a>

[![npm version](https://img.shields.io/npm/v/hikoutei?style=flat-square)](https://www.npmjs.com/package/hikoutei)
[![license](https://img.shields.io/npm/l/hikoutei?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

Hikoutei は、TypeScript と Node.js のアプリケーションで Google Sheets を
MVP や社内ワークフローの人間向けの画面として利用できるようにします。
アプリケーションは型付きエンティティとローカル SQLite を使い、付属の
Apps Script Gateway を通して変更を Google Sheets へ非同期に届けられます。

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

エンティティ定義と環境ごとの Sheet route を分離し、ルート API だけを使います。

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
  sheets: {
    spreadsheetId: process.env.SHEET_ID!,
    routes: {
      User: {
        systemState: { tabName: "Users_System", registeredRange: "A:Z" },
      },
    },
  },
});

const em = hikoutei.em.fork();
const user = em.create(User, { id: "u1", name: "Ada" });
em.persist(user);
await em.flush();

user.name = "Ada Lovelace";
await em.flush();
```

`createTypedSheets()` は SQLite とローカル canonical/outbox だけを準備します。
リモートのタブとヘッダーは `hikoutei.setupSheets(provisioner)` を明示的に呼び出して
プロビジョニングします。`flush()` の成功は SQLite と durable outbox のコミットを
意味し、リモート Sheet への配信は別の worker が非同期に行います。

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

1. `createTypedSheets()` で scalar entity と環境ごとの Sheet route を定義します。
2. [クイックスタート](docs/quick-start.md#sheet-setup-and-delivery) に従い、
   [`apps-script/gateway/Code.gs`](apps-script/gateway/Code.gs) を対象の
   Spreadsheet にバインドした Apps Script プロジェクトへコピーし、Web App として
   デプロイします。その後 `/exec` URL を入力して `setupSyncGateway()` を実行します。
3. 生成された `TYPED_SHEETS_GATEWAY_URL`、
   `TYPED_SHEETS_GATEWAY_SHARED_SECRET`、
   `TYPED_SHEETS_GATEWAY_SHEET_ID` を、追跡対象外のサーバー環境ファイルまたは
   secret store に保管します。shared secret をブラウザコードや Git に入れないでください。
4. `hikoutei.setupSheets(provisioner)` を明示的に呼び出して登録済みのタブとヘッダーを
   プロビジョニングし、保留中の outbox effect を配信する sync worker を実行します。

外部サーバーからアクセスするには、Web App のアクセス範囲でサーバーを許可する必要が
あり、通常は **Anyone** が必要です。エディタ専用の `/dev` ではなく、デプロイ用の
`/exec` URL を使用してください。`Code.gs` を変更した場合は、Web App deployment を
新しいバージョンに更新してから利用します。詳しい設定とトラブルシューティングは
[クイックスタート](docs/quick-start.md)を参照してください。

## ドキュメント

- [クイックスタート](docs/quick-start.md) — インストール、マッピング、Gateway 設定。
- [アーキテクチャ](docs/architecture.md) — ローカルストアと Sheet ビューの関係。
- [書き込みと同期の流れ](docs/write-and-synchronization-flow.md) — 非同期配信と復旧動作。
- [開発ガイド](docs/development.md) — ローカル開発とテストコマンド。
- [ベンチマーク記録](docs/sync-bulk-write-benchmark.md) — 日付ごとの測定結果と制約。

## 制限事項

- Google Sheets にはクォータ、レイテンシー、Apps Script の実行時間制限があります。
- Sheet の更新は非同期なので、アプリケーションはローカル状態を読み取るべきです。
- SQLite はサービスにローカルなもので、分散調整レイヤーではありません。
- スキーマ変更、手動編集、競合する変更に対する運用方針は、アプリケーション側で
  別途決める必要があります。

## ロードマップ

- Google Sheets から意図的なユーザー編集を取り込む機能を完成させる。
- update/delete の競合処理と表示を改善する。
- レジストリと Apps Script デプロイ用のセットアップツールを追加する。
- 公開パッケージのリリースを安定化する。

現在の作業については [open issues](https://github.com/ManddarinShop/Hikoutei/issues)
を参照してください。

## ライセンス

Hikoutei は [MIT License](LICENSE) の下で公開されています。
