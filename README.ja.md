[English](README.md) | [한국어](README.ko.md)

<div align="center">

# Hikoutei

**SQLite でアプリは高速に、Google Sheets でワークフローを見えるままに。**

Google Sheets を利用する MVP 向けの型付きリポジトリであり、安全な書き込み
レイヤー: アプリケーションは型付きエンティティでローカル SQLite を読み書きし、
コミットされた変更は、人が確認して軽くコラボレーションできるよう Google
Sheets へ非同期で投影されます。

<a href="https://www.npmjs.com/package/hikoutei">npm</a> ·
<a href="docs/quick-start.md">クイックスタート</a> ·
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

## クイックスタート

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

**シートには何が起きるのか?** 書き込みは即座にローカル SQLite へコミット
されます — アプリケーションのリクエストは Google を待ちません。同期サービスが
有効な場合、Hikoutei は後でエンティティを登録済みの Google Sheet へバック
グラウンドで投影します。シート上で行われた人の編集は観察・検証され、SQLite
へ受け入れられるか競合として記録されるかのどちらかで、決して静かに上書き
されません。

## Hikoutei を使う理由

- シートの行を手動で変換する代わりに、型付きエンティティを定義する。
- Google Sheets を待たずにローカル SQLite で読み書きする。
- コミットされた変更を Sheets へバックグラウンドで同期する。
- 予期しない列の変更や重複ヘッダーを検出する。
- 競合時に新しいシート編集を上書きしない。

## Hikoutei が適しているケース

Hikoutei は以下のケースに適しています。

- 製品ワークフローの一部にスプレッドシートがある MVP・プロトタイプ
- 社内ツールや低トラフィックの管理アプリケーション
- 人が Sheets を簡単に確認しつつ、型付きのアプリケーションデータを扱いたい
  チーム
- SQLite をローカルで使い、非同期のシート更新を受け入れられるサービス

## 他のツールを選ぶべきケース

次の要件がある場合は、通常のデータベースと Google API を直接使ってください。

- 多くの行やサービスにまたがる強いトランザクション
- 高い書き込みスループットや多数の同時ライター
- 複雑なクエリ・JOIN・レポートワークロード
- マルチサーバー・マルチリージョンでの調整
- Google Sheets での読み取り直後の整合性
- Google Sheets をアプリケーションの主要データベースとして使う場合

## Hikoutei はあなたに合った抽象化か?

Hikoutei は `google-spreadsheet` や `@googleapis/sheets` を置き換えるものでは
ありません — その一段上に位置します。生のスプレッドシート操作だけが必要なら、
API クライアントを直接使ってください。

| 機能 | Hikoutei | google-spreadsheet | @googleapis/sheets |
| --- | :-: | :-: | :-: |
| 型付きエンティティモデル | ✅ | ❌ | ❌ |
| 高速なローカルアプリケーション読み取り | ✅ | ❌ | ❌ |
| Sheets への非同期投影 | ✅ | ❌ | ❌ |
| 永続的な書き込み再試行と重複排除 | ✅ | ❌ | ❌ |
| 競合を考慮したシート更新 | ✅ | ❌ | ❌ |
| 行・セルの直接操作 | 限定的 | ✅ | ✅ |
| Google Sheets API へのフルアクセス | Provider 経由 | 部分的 | ✅ |

## Google Sheets の設定

Google Sheets の同期はサービス側の関心事です。アプリケーションは provider
クライアントを import したり、`createTypedSheets()` にシートルートを渡したり、
書き込みごとに操作を選んだりしません。同期ランタイムはサービスアカウントを
使う単一の Google Sheets API provider(内部 `googleSheetsApi` bootstrap オプ
ション)を使用します — Apps Script のデプロイは不要です。

### 環境変数による同期の自動開始

スプレッドシートの URL を環境変数に設定すると、`createTypedSheets()` が内部で
Sheets 同期を開始します — `flush()` はセットアップコードなしで outbox
ワーカー経由で Google Sheets に流れます:

```sh
HIKOUTEI_SYNC_SPREADSHEET_URL=https://docs.google.com/spreadsheets/d/<ID>/edit
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

```ts
const hikoutei = await createTypedSheets({ dbName: "./hikoutei.sqlite", entities: [User] });
```

`HIKOUTEI_SYNC_SPREADSHEET_URL` がない場合、`createTypedSheets()` はローカル
専用 (SQLite) のままです。起動失敗は明確なメッセージで診断されます: URL の
不正、資格情報ファイルの欠落・不正、スプレッドシートに共有されていない
サービスアカウント (共有すべきメールアドレスをエラーが教えてくれます)。

### Service-account provider (googleSheetsApi)

1. **サービスアカウントを作成する。** Cloud プロジェクトで Google Sheets API
   を有効化し、`https://www.googleapis.com/auth/spreadsheets` スコープの
   サービスアカウントを作成して、対象スプレッドシートをそのメールアドレスに
   **編集者(Editor)**として共有します。provider がタブを作成し、効果行と
   receipt レコードを書き、行アンカーを管理するため、閲覧者権限では不十分
   です。
2. **キーはサーバー側に置く。** サービスアカウントのキーパスはサーバーの
   `GOOGLE_APPLICATION_CREDENTIALS` に、スプレッドシート ID は追跡されない
   シークレットストアに置きます。キーをブラウザコードや Git に入れないで
   ください。
3. **内部 sync bootstrap を起動する。** `googleSheetsApi` を設定すると、
   登録済みタブのヘッダーを作成・検証した後、outbox 配信と User_Input ポー
   リングを開始します。

Hikoutei は、永続的なローカル outbox・冪等な配信・競合を考慮した更新を使う
ため、一時的な API 障害でコミット済みのアプリケーション書き込みが失われる
ことはありません。provider は資格情報・スプレッドシート ID・URL・ペイロードを
ログに残さず、Google の割り当て枠に収まるようリクエスト開始間隔を調整します。
詳細な状態機械と復旧ルールは[内部整合性モデル](docs/internal-consistency-model.md)を
参照してください。

ライブの Google 呼び出しはオプトインであり、通常の検証経路はフェイク
provider と SQLite フィクスチャです。詳細なセットアップとトラブルシューティン
グは[クイックスタート](docs/quick-start.md)を参照してください。

## インストール

プロジェクト名と npm パッケージ名はどちらも `hikoutei` です。現在の組み込み
SQLite provider は MikroORM を必要とします。

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

MikroORM は実装の詳細であり、Hikoutei の公開エンティティ API には現れません。

## ドキュメント

- [クイックスタート](docs/quick-start.md) — インストール、ORM ライフサイクル、
  サービス側の同期設定
- [アーキテクチャ](docs/architecture.md) — ローカルストアとシートビューの関係
- [書き込みと同期フロー](docs/write-and-synchronization-flow.md) — 非同期配信と
  復旧動作
- [内部整合性モデル](docs/internal-consistency-model.md) — 永続的な outbox、
  冪等な配信、競合を考慮した更新
- [開発](docs/development.md) — ローカル開発とテストコマンド
- [ベンチマークノート](docs/sync-bulk-write-benchmark.md) — 日付付きの測定と
  その限界

## 制限事項

- Google Sheets には割り当て枠・レイテンシ・API レート制限があります。
- シートの更新は非同期であり、アプリケーションはローカル状態を読むべきです。
- SQLite はサービスのローカルのみであり、分散調整レイヤーではありません。
- スキーマ変更・手動編集・競合更新には、依然としてアプリケーションの運用
  ポリシーが必要です。

## ローカルクエリ

読み取りは Hikoutei 独自の型付き演算子を使い、常に SQLite で実行されます。

```ts
const [users, total] = await em.findAndCount(
  User,
  {
    name: { like: "Ada%" },
    age: { gte: 18, lt: 65 },
    active: { in: [true] },
  },
  {
    orderBy: { age: "desc", name: "asc" },
    limit: 20,
    offset: 0,
  },
);
```

`eq`、`ne`、`gt`、`gte`、`lt`、`lte`、`in`、`nin` は、宣言された
スカラー型で有効な範囲で利用でき、`like` は文字列専用です。
`{ active: true }` のような等価条件の省略記法も引き続き利用できます。
`count()` はページネーション前のフィルター総数を返し、`findAndCount()` は
1 つの SQLite スナップショットからページと総数を読み取ります。明示的な
並び順には最後のタイブレーカーとして主キーが追加され、`orderBy` のない
ページネーションは主キーの昇順を使用します。

## プロジェクトステータス

Hikoutei は活発に開発中です。現在の EntityManager は、スカラーエンティティの
ライフサイクル操作、型付きローカルフィルターと並び順、`limit` / `offset`
ページネーション、`count()`、スナップショット整合性のある `findAndCount()`、
コールバック形式の `transactional()` をサポートします。通常の読み取り元は
常に SQLite であり、Google Sheets ではありません。シート編集の取り込みと
競合表示はまだ発展途上です。マイナーバージョンのアップグレード前にリリース
ノートを確認してください。

## ロードマップ

最初の EntityManager 段階である豊富なローカル読み取りは完了しました。残る段階は
以下の実装順序に従い、日付やリリース番号は約束しません。

1. **ライフサイクル安全な書き込み**
   - `upsert` と direct/bulk mutation 機能は、エンティティテーブル、
     canonical state、永続的な Sheet effect outbox を 1 つの SQLite
     トランザクションで処理する Hikoutei 独自の契約を通じてのみ追加します。
   - この原子的なライフサイクルを迂回し得る、生の `nativeInsert`、
     `nativeUpdate`、`nativeDelete`、または SQL パススルー API は約束しません。
2. **リレーションとロード**
   - many-to-one、one-to-many、`populate()` 機能を追加します。
   - 公開前に、リレーションの SQLite マッピング、Sheets プロジェクション
     表現、スキーマ動作、競合セマンティクスを一体として設計します。
3. **スキーマ運用**
   - マイグレーションとスキーマドリフト管理を追加します。
   - 検証と運用フローを既存のセットアップツールと統合します。

### 同期と運用

以下の作業は EntityManager の各段階と並行して進めます。

- Google Sheets からの意図的なユーザー編集の取り込みを完了する
- 更新・削除の競合処理と表示を改善する
- レジストリと direct-provider デプロイのセットアップツールを改善する

現在の作業は[オープンな Issues](https://github.com/ManddarinShop/Hikoutei/issues)を
参照してください。

## ライセンス

Hikoutei は [MIT ライセンス](LICENSE)で公開されています。
