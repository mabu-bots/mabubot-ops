# 運営ボット（mabubot-ops）

| 項目 | 内容 |
| --- | --- |
| バージョン | v1.0.0 |
| 状態 | 稼働中 |
| 稼働先 | 台2（ConoHa VPS、pm2 アプリ名 `mabubot-ops`） |
| 実装 | TypeScript + discord.js v14 / Node 24 / SQLite（`node:sqlite`） |

まぶさばボット（mabubot）を機能グループごとに切り分けたうちの、**運営系**担当の Bot です。元の mabubot から `welcome`（歓迎・自動役職）、`poll`（投票）、`recruit`（募集）、`timer`（タイマー）を分離し、運営スケジューラーと下書き承認フローを担います。単独で起動でき、他の mabubot-\*（play / guard）や p1228・logbot とは接続しません。

## ✨ できること

- **👋 歓迎メッセージ**: メンバー参加時に、設定したチャンネルへ歓迎メッセージを送信（`{user}` `{server}` `{count}` の置換対応）。公式 X / note への案内も併記します
- **🎭 自動役職**: 参加時に役職を自動付与（ギルドごとに最大10件）
- **🗳️ 投票**: ボタンで投票する投票を作成（1人1票・変更可・自動締切）
- **📣 募集**: 参加/不参加ボタン付きの募集を作成（定員・開始時刻で自動締切）
- **⏰ タイマー**: リマインダーを設定（再起動後も再スケジュールされます）
- **🗓️ 運営スケジューラー**（運営自動化設計書 v1.1 の実装）: 決まった曜日・時刻にテンプレート投稿や下書き生成を自動実行します。冪等キーで二重投稿を防ぎ、同日中の取りこぼしは復帰後にキャッチアップします。連続3回失敗したスケジュールは自動で一時停止します
- **📝 下書き承認フロー**: X 向け告知・週次振り返り・月報などは下書きとして作られ、管理者が承認するまで外に出ません。Discord 向け下書きは承認でそのまま投稿されます（ボタンでも承認・却下できます）
- **📊 日次集計**: 発言数（本文は保存せず件数だけ）・参加/退出・投票/募集の実施数を日ごとに集計し、週次振り返りと月報の下書きに使います
- **🎮 プレゼンス**: 全 Bot 共通のプレゼンス・サイクル（Playing、1分ごとに「起動して ○○」と「現在時刻 ○○ JST」を交互表示）

コマンドの返信は埋め込みメッセージで、基本的に実行者にだけ見えます（限定表示）。`/welcome test` `/help` と、投票・募集の作成結果など、みんなで見たほうがいいものは公開メッセージです。フッターは `✨ まぶさば` です。

## ⌨️ コマンド

`/welcome` `/autorole` `/ops` はサーバー管理（Manage Guild）権限が必要です（定義の既定権限に加え、ハンドラでも実行時チェックします）。それ以外は誰でも使えます。

| コマンド | 説明 | 備考 |
| --- | --- | --- |
| `/welcome set channel:<#チャンネル> [message:<文言>]` | 歓迎メッセージを設定（`{user}` `{server}` `{count}` が使えます） | 管理者 |
| `/welcome show` | 現在の設定を表示 | 管理者 |
| `/welcome disable` | 歓迎メッセージを止める | 管理者 |
| `/welcome test` | 歓迎メッセージの見た目を確認 | 管理者・公開表示 |
| `/autorole set role:<役職>` | 参加時に自動で付与する役職を追加（繰り返し実行で複数設定可、最大10件） | 管理者 |
| `/autorole remove [role:<役職>]` | 指定した1件の自動役職を解除（未指定ならすべて解除） | 管理者 |
| `/autorole show` | 現在の自動役職を一覧表示 | 管理者 |
| `/poll create question:<質問> option1:<選択肢1> option2:<選択肢2> [option3〜5] [duration:<分>]` | 投票を作成（期間は1〜1440分、未指定なら60分） | 公開表示 |
| `/recruit create title:<タイトル> members:<定員 2〜20> time:<開始時刻> [description:<説明>]` | 募集を作成 | 公開表示 |
| `/timer set minutes:<分数 1〜1440> message:<内容>` | タイマーを設定（期限に同チャンネルでメンション付きリマインダー） | |
| `/timer list` | 設定中のタイマーを一覧表示 | |
| `/timer cancel id:<ID>` | タイマーをキャンセル（設定した本人だけがキャンセルできます） | |
| `/ops schedule list` | スケジュール一覧を表示 | 管理者 |
| `/ops schedule defaults channel:<#チャンネル>` | 標準スケジュール6件を一括登録 | 管理者 |
| `/ops schedule add kind:<種別> time:<時刻> template:<テンプレート> [channel] [days] [mode]` | スケジュールを追加 | 管理者 |
| `/ops schedule pause id:<ID>` | スケジュールを一時停止 | 管理者 |
| `/ops schedule resume id:<ID>` | スケジュールを再開 | 管理者 |
| `/ops schedule remove id:<ID>` | スケジュールを削除 | 管理者 |
| `/ops draft list` | 承認待ちの下書き一覧を表示 | 管理者 |
| `/ops draft approve id:<ID>` | 下書きを承認（Discord向けは投稿されます） | 管理者 |
| `/ops draft reject id:<ID>` | 下書きを却下 | 管理者 |
| `/ops run id:<ID>` | スケジュールを今すぐ1回実行 | 管理者 |
| `/ops stats` | 直近7日の集計を表示 | 管理者 |
| `/ops announce template:<テンプレート> [channel]` | テンプレートからお知らせの下書きを作りプレビュー表示（承認ボタン付き） | 管理者 |
| `/ping` | 応答確認 | |
| `/help` | コマンド一覧を表示 | 公開表示 |

補足:

- `/autorole set` は追加式です。新しい役職を設定しても、すでにある自動役職は消えません。参加時には設定した役職をすべて付与します（まず一括付与を試し、失敗したら役職ごとに再試行します）。Bot の役職と同じか上位の役職・@everyone・連携サービス管理の役職は設定時に弾きます。強い権限を持つ役職を設定すると警告を表示します。
- 投票はボタンで投票します（1人1票・変更可）。投票数は埋め込みに即時反映され、期限が来ると自動で締め切って結果を表示します。投票内容はSQLiteに保存されます。
- 募集の開始時刻は日本時間で `21:00` / `30分後` / `2026-11-14 21:00` のように書けます。参加/不参加ボタンで参加者一覧が埋め込みに反映され、定員に達すると「満員」表示になり、開始時刻を過ぎると自動で締め切ります。開始時刻が約24.8日（setTimeout の上限）より先の場合は、締切スケジュールを分割して張り直します。
- タイマーはSQLiteに保存され、Botの再起動後も再スケジュールされます（期限切れのものは起動時にすぐ鳴ります）。
- 投票・募集は、公開メッセージの送信前に DB へ登録する DB-first 方式です。送信に失敗した場合は行を巻き戻すため、ボタンが動作しないメッセージが残ることはありません。

### 📋 運営スケジューラーの仕様メモ

- 時刻はすべて日本時間（Asia/Tokyo）で判定し、実行環境のタイムゾーンに依存しません。ティックは1分間隔です。
- 自動投稿は `allowedMentions: { parse: []}` で送られ、テンプレート変数に含まれる `@everyone` 等のメンション記法は無害化されます（`<#...>` のチャンネル参照は残ります）。
- 投稿レートは1サーバーあたり1時間に4件までです。超えた分は次回ティックへ回ります（集計系は対象外）。
- X の認証情報は Bot に持たせません。X / note 向けは下書きの生成と承認までが Bot の役割で、実際の外部投稿は Bot の外で行います。
- 追加テーブルは既存 DB（`data/mabubot-ops.db`）内の `ops_schedules` / `ops_runs` / `ops_drafts` / `ops_stats_daily` です。他の Bot の DB へは書き込みません。
- 旧 mabubot からの切替は**データを移行しない新規開始**に決定済みです（2026-11-19）。XP・警告・進行中の投票/募集/タイマーは引き継ぎません。

## ⚙️ 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_TOKEN` | ○ | Discord Bot のトークン |
| `DISCORD_APPLICATION_ID` | ○ | Discord アプリケーション ID（コマンド同期・削除に使う） |
| `DATA_DIR` | ― | SQLite データの保存先。既定は `./data`（`data/mabubot-ops.db`） |
| `DB_BACKUP_RETENTION` | ― | 起動時 DB バックアップの保持世代数。既定は 10 |
| `DISCORD_GUILD_ID` / `DISCORD_GUILD_IDS` | ― | `clear:commands` でギルドコマンドも消す場合に指定（カンマ区切り可） |

## ⚙️ 必要なDiscord設定

1. [Discord Developer Portal](https://discord.com/developers/applications) で **mabubot-ops 用の新しいアプリケーション** を作成し、Bot を追加します（元の mabubot や他の Bot のアプリは使いません。各 Bot でアプリが別々に必要です）。
2. Bot 設定で Privileged Gateway Intents を有効にします：
- **Server Members Intent**（参加イベント・自動役職に必要）
- Message Content Intent は不要です
3. サーバーに Bot を招待します。権限は「チャンネルを見る」「メッセージを送信する」「埋め込みリンク」「ロールを管理」を付与してください。自動役職は、Bot の役職より下にある役職にしか付与できません。
4. `.env.example` を `.env` にコピーし、`DISCORD_TOKEN` と `DISCORD_APPLICATION_ID` を設定します。**トークンはチャットには送らず、`.env` にだけ入れてください。**

## 🚀 起動

```bash
npm ci
npm run build
npm run sync:commands # スラッシュコマンドを上書き同期（初回・コマンド変更時に実行）
npm start
```

### 🔨 ビルド（ワンコマンド）

依存関係のインストール → 型チェック → ビルド → テストまでを 1 コマンドで実行するスクリプトを用意している。失敗した場合は、そのステップで止まってどこで落ちたかを表示する。テストは `dist/` に対して実行されるため、スクリプト内でもビルドを先に行う。

```bat
build.bat
```

```sh
./build.sh
```

開発時は `npm run dev` で起動できます。設定・投票・募集・タイマーは `data/mabubot-ops.db`（SQLite、Node 標準の `node:sqlite`）に保存され、再起動しても残ります。Node 24 以上が必要です。

> [!NOTE]
> `.env` は自動では読み込まれません。`DISCORD_TOKEN` / `DISCORD_APPLICATION_ID` はシェルに export するか、systemd の `EnvironmentFile=` で渡してください。pm2 で起動する場合は `ecosystem.config.cjs` が `.env` を読み込むので、このままで大丈夫です。

## 🖥️ pm2で自動起動

VPSの再起動後もBotが自動で立ち上がるように、pm2で管理します。

```bash
pm2 start ecosystem.config.cjs
pm2 startup # 表示されたコマンドを実行
pm2 save
```

## 🔁 コマンド同期（上書き同期式）

スラッシュコマンドの登録は `npm run sync:commands` だけが行います。Bot の起動時には同期しません。実行すると、このアプリのグローバルコマンドを PUT で全置換し、同期後に再取得して検証します。コマンド定義を変えたら必ず実行し直してください。古いコマンドを全削除したい場合は `npm run clear:commands` を使います。

## 🔀 元 mabubot からの移行メモ

- **担当データ**: `welcome`、`autorole`、`polls` / `poll_votes`、`recruits` / `recruit_members`、`timers`、および運営スケジューラー用の `ops_*` テーブル。DB ファイルは `data/mabubot-ops.db` です（元 mabubot は `data/mabusaba.db`）。
- **切替はデータを移行しない新規開始です。** 旧 DB からのコピーは行いません。進行中の投票・募集は旧 Bot の停止と同時に終了扱いになり、タイマーは発火しません。歓迎メッセージ・自動役職などの設定は切替後に設定し直してください。
- **切り替え時の注意**:
- 旧 mabubot と mabubot-ops を**同時に稼働させないでください**。歓迎メッセージや自動役職が二重に実行されます。
- 旧 mabubot が投稿した投票・募集のボタンを mabubot-ops が処理できるかは**未確認のまま待機**です（旧 Issue #5）。Discord はコンポーネント操作を作成元のアプリへ配送するため、動作しない可能性があります。新規開始の決定により、旧ボタンが切替後に動作しないことは受け入れ済みです。

## 🗂️ 構成

- `src/index.ts` — 起動・Intents（コマンド同期はしない）、起動時に投票・募集・タイマーを再スケジュールし、運営スケジューラーを開始
- `src/sync-commands.ts` — スラッシュコマンドの上書き同期（PUT 全置換＋検証）
- `src/clear-commands.ts` — アプリケーションのコマンド全削除（グローバル＋ギルド）
- `src/commands.ts` — この Bot のスラッシュコマンド定義と振り分け
- `src/store.ts` — SQLite ストア（welcome / autorole / polls / recruits / timers / ops_schedules / ops_runs / ops_drafts / ops_stats_daily）
- `src/util.ts` — 埋め込み返信・時刻解析・ID 生成・表示整形・コマンド実行ログ
- `src/welcome.ts` — 歓迎メッセージ・自動役職
- `src/poll.ts` — 投票（ボタン投票・自動締切）
- `src/recruit.ts` — 募集（参加/不参加ボタン・満員・自動締切）
- `src/timer.ts` — タイマー（リマインダー・再起動後の再スケジュール）
- `src/scheduler.ts` — 運営スケジューラー（due 判定・冪等・レート制限・失敗時の自動停止・標準スケジュール）
- `src/templates.ts` — 投稿テンプレート9種とメンション無害化
- `src/stats.ts` — 日本時間ヘルパーと週次集計の要約
- `src/announce.ts` — スケジュールの実行（投稿・下書き生成・集計確定）
- `src/ops.ts` — `/ops` コマンドと下書き承認ボタンの処理
- `src/events.ts` — GuildMemberAdd（ウェルカム・自動ロール）・ボタン処理・集計用の件数カウント
- `src/backup.ts` — 起動時 DB バックアップ（世代管理）
- `src/watchdog.ts` — READY ウォッチドッグ（Gateway のサイレント停滞検知）
- `src/presence-cycle.ts` — プレゼンス・サイクル（全 Bot 共通形式）
- `tests/` — 単体テスト（時刻解析・ストア・テンプレート・スケジューラー・バックアップ・ウォッチドッグ・プレゼンス）

## 🧭 判断記録

- **ゼロから再実装し、バージョンを 1.0.0 に振り直した（2026-11-28）**: 統一開発フロー（aegis-bot が基準）への移行にあわせ、旧実装（最終 v0.2.1）を棚卸しして全機能を再実装した。コードの構成・コメント規約・ドキュメント形式を基準に揃え、振る舞い（コマンド定義・文言・閾値・保存形式）は旧実装と一致させた。詳細は DESIGN.md の対応表と判断記録を参照。
- **開発手順を統一した（2026-11-28）**: Issue → ブランチ → PR → Rebase and merge の手順、Conventional Commits＋英語の件名、タグ＋GitHub Release（ノートのみ）のリリース手順を採用した。手順の正本は CONTRIBUTING.md。
- **データ保存形式は変えない**: 本番の `data/mabubot-ops.db` をそのまま読み続けられるよう、テーブル定義・キー・既定の保存先は旧実装と同一にした。旧形式（ギルドに1件）の自動ロールテーブルからの移行処理もそのまま持つ。

## Development

開発手順（Issue → ブランチ → PR → Rebase and merge）とコミット規約は [CONTRIBUTING.md](CONTRIBUTING.md) を参照。設計と判断記録は [DESIGN.md](DESIGN.md)、変更履歴は [CHANGELOG.md](CHANGELOG.md) にある。

## License

MIT — [LICENSE](LICENSE) を参照。
