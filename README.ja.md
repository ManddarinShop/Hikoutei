[English](README.md) | [한국어](README.ko.md)

<div align="center">

<img src="website/public/hikoutei-logo.png" alt="Hikoutei" width="220" />

# Hikoutei

**SQLite でアプリは高速に、Google Sheets でワークフローを見えるままに。**

Google Sheets を利用する MVP 向けの型付きリポジトリであり、安全な書き込み
レイヤー: アプリケーションは型付きエンティティでローカル SQLite を読み書きし、
コミットされた変更は、人が確認して軽くコラボレーションできるよう Google
Sheets へ非同期で投影されます。

<a href="https://www.npmjs.com/package/hikoutei">npm</a> ·
<a href="website/guide/quick-start.md">クイックスタート</a> ·
<a href="https://github.com/ManddarinShop/Hikoutei/issues">Issues</a>

[![npm version](https://img.shields.io/npm/v/hikoutei?style=flat-square)](https://www.npmjs.com/package/hikoutei)
[![license](https://img.shields.io/npm/l/hikoutei?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

## Hikoutei とは

Hikoutei は、TypeScript アプリケーションにローカル SQLite を基盤とする型付き
エンティティ API を提供し、コミットされた変更を Google Sheets へ非同期に
同期します。

通常の読み書きでは、アプリケーションは Google Sheets を待ちません。Sheets は
確認・運用・軽いコラボレーションのための画面として残ります。

> Hikoutei は生の Sheets API ラッパーではなく、PostgreSQL の代替でもなく、
> Google Sheets を権威あるアプリケーションデータベースとして扱いません。
> SQLite が真実の源泉であり、Sheets は人向けの画面です。

## Hikoutei を使う理由

- シート行を手動で変換する代わりに、型付きエンティティを定義できます。
- Google Sheets を待たずにローカル SQLite で読み書きできます。
- コミットされた変更をバックグラウンドで Sheets に同期します。
- 想定外の列変更や重複ヘッダーを検出します。
- 競合時に新しいシート編集を上書きしません。

Hikoutei は `google-spreadsheet` や `@googleapis/sheets` の代わりではなく、
その一段上に位置します。生のスプレッドシートアクセスだけが必要なら API
クライアントを直接使ってください。

| 機能 | Hikoutei | google-spreadsheet | @googleapis/sheets |
| --- | :-: | :-: | :-: |
| 型付きエンティティモデル | ✅ | ❌ | ❌ |
| 高速なローカルアプリ読み取り | ✅ | ❌ | ❌ |
| Sheets への非同期投影 | ✅ | ❌ | ❌ |
| 耐久性のある書き込みリトライと重複排除 | ✅ | ❌ | ❌ |
| 競合を考慮したシート更新 | ✅ | ❌ | ❌ |
| 行・セルの直接操作 | 限定的 | ✅ | ✅ |
| Google Sheets API へのフルアクセス | Provider 経由 | 一部 | ✅ |

## インストール

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

ライブラリのインストールだけでは Google Cloud には何も作られません —
デフォルトはローカル専用(SQLite)で動作します。シート同期が必要なときだけ
下の setup を実行してください。

## セットアップ(Google Sheets 同期)

一回きりの対話操作です。gcloud CLI をインストールしてから:

```sh
npx hikoutei setup
```

Cloud プロジェクト・サービスアカウント・キー・スプレッドシートを作成し、
`.env` まで書き出します。`HIKOUTEI_SYNC_SPREADSHEET_URL` がなければ
`createTypedSheets()` はローカル専用(SQLite)のままです。詳細な設定、
クレデンシャルプール、クォータガイド、手動セットアップ:
[Google Sheets の設定](website/guide/setup.md)。

## 使い方

スカラーエンティティを定義し、リクエストローカルなマネージャーでローカル
SQLite の権威を利用します。

```ts
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
    age: { type: "number" },
    active: { type: "boolean" },
  },
});

const hikoutei = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
});

const em = hikoutei.em.fork();
const user = em.create(User, { id: "u1", name: "Ada", age: 36, active: true });
em.persist(user);
await em.flush();

user.name = "Ada Lovelace";
await em.flush();

const loaded = await em.findOne(User, { id: "u1" });
if (loaded !== null) {
  em.remove(loaded);
  await em.flush();
}
```

読み取り・トランザクション・演算子の詳細:
[クイックスタート](website/guide/quick-start.md)。

書き込みは即座にローカル SQLite にコミットされます — リクエストは Google を
待ちません。シートで人が編集するとポーリングで戻ってきて、SQLite に取り込まれる
か競合として記録され、黙って上書きされることはありません。パイプライン全体
(outbox、配信、競合処理)は
[書き込みと同期フロー](website/guide/sync-flow.md) を参照してください。

## さらに読む

- [クイックスタート](website/guide/quick-start.md) — インストール、ORM
  ライフサイクル、同期セットアップ
- [アーキテクチャ](website/guide/architecture.md) — ローカルストアとシート
  画面の連携
- [書き込みと同期フロー](website/guide/sync-flow.md) — 非同期配信とリカバリ
- [制限事項](website/guide/limitations.md) — 他のツールを選ぶべきケース
- [プロジェクトステータスとロードマップ](website/guide/status.md) — 完了済みと次の作業

## ライセンス

Hikoutei は [MIT ライセンス](LICENSE) のもとで公開されています。