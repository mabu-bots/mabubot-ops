# mabubot-ops 設計書

## 1. 位置づけ

mabubot-ops は、まぶさばボット（mabubot）を機能グループごとに切り分けたうちの運営系担当 Bot である。歓迎・自動役職、投票、募集、タイマーの分離担当分に、運営スケジューラー（運営自動化設計書 v1.1 の実装）と下書き承認フローを持つ。単独で起動でき、他の mabubot-\*（play / guard）や p1228・logbot とは接続しない。

本プロジェクトは、統一開発フロー（aegis-app/aegis-bot で確立した手順）への移行にあわせて、旧 mabubot-ops をゼロから再実装したものである（2026-11-28、v1.0.0）。再実装の棚卸しの正は **本番サーバー（台2）のスナップショット** とした。

引き継ぐもの: 旧実装の全機能・全コマンド、表示文言、各種閾値、SQLite の保存形式（本番 DB をそのまま読めること）。
引き継がないもの: 旧コードそのもの。

## 2. アーキテクチャ

```
Discord Gateway
  │  guildMemberAdd / guildMemberRemove / messageCreate / interactionCreate
  ▼
events.ts ──► welcome.ts（歓迎・自動ロール）
  │        ├─► store.ts の日次集計（件数カウント）
  │        └─► ボタン振り分け（poll / recruit / opsdraft）
commands.ts ─► welcome / poll / recruit / timer / ops の各ハンドラ
scheduler.ts ─► announce.ts（投稿・下書き生成・集計確定）
  ▼
store.ts（SQLite: data/mabubot-ops.db、Node 標準 node:sqlite）
```

- 起動（index.ts）はコマンド同期を行わない。コマンド登録は `sync-commands.ts` の上書き同期だけが行う。
- READY が来ないサイレント停滞は watchdog.ts が検知し、プロセス終了で pm2 に再起動させる。
- プレゼンスは presence-cycle.ts の全 Bot 共通サイクルが担う。
- 投票・募集・タイマーは SQLite に保存され、起動時に再スケジュールされる（期限切れは即時に締切・発火）。
- 運営スケジューラーは1分ティックで due 判定し、実行の中身は announce.ts の executor に注入される（判定と実行の分離でテスト可能にする）。

モジュール構成:

| モジュール | 役割 |
| --- | --- |
| `src/index.ts` | エントリポイント。Client 生成、ウォッチドッグ取り付け、スケジューラー配線、起動時再スケジュール、コマンド実行の例外処理と実行ログ |
| `src/commands.ts` | 全8コマンドの定義（SlashCommandBuilder）と振り分け、/help・/ping |
| `src/sync-commands.ts` | グローバルコマンドの上書き同期（PUT 全置換＋検証） |
| `src/clear-commands.ts` | コマンド全削除（グローバル＋任意でギルド） |
| `src/store.ts` | SQLite ストア（全テーブル、自動ロールの旧形式移行、起動時バックアップ呼び出しを含む） |
| `src/util.ts` | 埋め込み返信、時刻パース（日本時間）、ID 生成、表示整形、コマンド実行ログ |
| `src/welcome.ts` | 歓迎メッセージ（テンプレート展開・送信）と自動ロール（複数・一括→個別再試行・階層/強い権限チェック） |
| `src/poll.ts` | 投票（ボタン投票・票数表示・自動締切、DB-first 登録） |
| `src/recruit.ts` | 募集（参加/不参加・満員・自動締切、24.8日超の遅延は分割スケジュール） |
| `src/timer.ts` | タイマー（メンション付きリマインダー、本人だけキャンセル可） |
| `src/templates.ts` | 投稿テンプレート9種とメンション無害化、描画 |
| `src/stats.ts` | 日本時間ヘルパー（日付・月末日曜・スケジュール時刻）と週次集計の要約 |
| `src/scheduler.ts` | 運営スケジューラー（due 判定・冪等キー・レート制限・手動実行・標準スケジュール6件） |
| `src/announce.ts` | スケジュールの実行（投稿・下書き生成・集計確定）とメンション無効化投稿 |
| `src/ops.ts` | /ops コマンド（schedule / draft / run / stats / announce）と下書き承認ボタン |
| `src/events.ts` | guildMemberAdd / guildMemberRemove / messageCreate（集計カウント）、ボタン処理の振り分け |
| `src/backup.ts` | 起動時 DB バックアップ（WAL チェックポイント＋サイドカー複写、世代 pruning） |
| `src/presence-cycle.ts` | プレゼンス・サイクル（Playing、1分交替、境界の200ms前に先行送信） |
| `src/watchdog.ts` | READY ウォッチドッグ（判定ロジック ReadyWatchdog と client への取り付け） |

## 3. データ保存

保存先は SQLite ファイル1つ（既定 `data/mabubot-ops.db`、`DATA_DIR` で変更可）。Node 標準の `node:sqlite` を使い、ネイティブ依存を持たない。ジャーナルは WAL、synchronous は NORMAL。

テーブル（旧実装と同一）:

| テーブル | 内容 |
| --- | --- |
| `welcome` | ギルドごとの歓迎設定（通知先チャンネル・文言） |
| `autorole` | ギルドごとの自動ロール（主キー guild_id + role_id、複数可） |
| `polls` / `poll_votes` | 投票（選択肢は JSON）と票（1人1票、主キー poll_id + user_id） |
| `recruits` / `recruit_members` | 募集と参加者 |
| `timers` | タイマー（発火時刻つき） |
| `ops_schedules` | 運営スケジュール（曜日は JSON、失敗連続・最終実行キーを保持） |
| `ops_runs` | スケジュール実行履歴（主キー相当は UNIQUE(schedule_id, run_key) の冪等キー） |
| `ops_drafts` | 承認待ち下書き（状態 pending / approved / rejected / published） |
| `ops_stats_daily` | 日次集計（主キー guild_id + date。発言件数・参加/退出・イベント実績。本文は保存しない） |

旧形式の自動ロールテーブル（主キーが guild_id のみ）が存在する場合は、ストア初期化時に複数形式へ移行し、既存の行を引き継ぐ（本番 DB の移行経路であり、テストでも検証する）。

起動時には DB を `data/backups/<timestamp>/` へコピーし、直近10世代（`DB_BACKUP_RETENTION` で変更可）を保持する。

## 4. 仕様の要点

### 4.1 歓迎・自動ロール

- 歓迎文のプレースホルダは `{user}` `{server}` `{count}`。展開後に埋め込み上限（4096字）を超える場合は末尾を省略記号で切り詰める。
- 自動ロールはギルドごとに最大10件、追加式。@everyone・連携管理ロール・Bot の最上位以上のロールは設定時に拒否し、強い権限を持つロールには警告を出す。
- 付与は一括 → 失敗時は個別再試行。失敗はログに残し、参加処理は止めない。

### 4.2 投票・募集・タイマー

- 作成は DB-first: 公開メッセージの送信前に行を登録し、message_id を後から埋める。送信失敗時は行を巻き戻す。
- 投票は1人1票・変更可、埋め込みへ即時反映、期限で自動締切。募集は定員で満員表示、開始時刻で自動締切。
- 募集の締切は setTimeout 上限（約24.8日）を超える遅延を分割して張り直す。
- タイマーのキャンセルは設定した本人だけ（ID は一覧で全員に見えるため）。

### 4.3 運営スケジューラー

- 判定はすべて日本時間。ティックは1分間隔で、due 判定は「有効・曜日/種別が合う・予定時刻を過ぎた・今日分が未実行」の4条件。
- 冪等キーは日単位（JST の日付文字列）。実行履歴テーブル `ops_runs` の UNIQUE 制約でも二重実行を防ぐ。手動実行は `manual:` キーで通常キーと分ける。
- キャッチアップ: Bot が止まっていた間に過ぎた分は、同日中なら復帰後のティックで実行される。日を跨いだ分は対象にならない。
- 投稿レート制限: 1ギルド1時間に4件まで（`stats_daily` は対象外）。超えた分は skipped として記録し、次回ティックへ回る。
- 失敗時は失敗連続を数え、3回連続で自動一時停止する。失敗した実行は last_run_key を更新しないため、同日中の再試行が可能。
- 標準スケジュール6件（月曜の予定・水曜の企画・金曜の告知・日曜の振り返り・毎日の集計・月末の月報）は `/ops schedule defaults` で一括登録できる。

### 4.4 テンプレートと下書き承認フロー

- テンプレートは9種（weekly_plan / midweek_poll / weekend_event / recruit_monthly / weekly_review / x_event / x_bot_intro / note_monthly / event_report）。`{変数}` を置換し、値はメンション無害化を通す。未設定の変数は「（未設定）」として残す。
- メンション無害化: `@everyone` / `@here` はゼロ幅スペースを挟み、`<@...>` / `<@&...>` はプレーンテキストへ落とす。`<#...>` のチャンネル参照は残す。
- 自動投稿は `allowedMentions: { parse: [] }` で送る。
- 下書きの決定は pending のときだけ可能（二重承認で二重投稿にならない）。Discord 向け下書きは承認で投稿し published に、X / note 向けは approved で留める（外部投稿は Bot の外で行う）。

### 4.5 日次集計

- 発言は件数とチャンネル別件数だけを数え、本文は保存しない。参加/退出、投票・募集の実施数と参加延べ人数も数える。
- 週次振り返りは直近7日、月報は直近30日の集計から変数を組み立てる。

### 4.6 プレゼンス・サイクル

- 形式: Playing で「<Bot名> | 起動して <経過>」と「<Bot名> | 現在時刻 HH:MM JST」を1分ごとに交互表示。位相は Unix 分の偶奇で決まり、全 Bot が同時に切り替わる。
- 値は次の分の境界時点のものを計算し、境界の200ms前に先行送信する（伝播遅延の実測中央値 190ms と相殺）。
- 経過時間の起点は最初の開始時刻に固定し、再接続・再適用ではリセットしない。

### 4.7 READY ウォッチドッグ

- READY でない状態が120秒続いたらプロセスを終了する（確認間隔30秒）。READY 喪失の瞬間から数え直し、発動後は起点をリセットする。

### 4.8 コマンド同期

- 登録は `npm run sync:commands` のみ。PUT 全置換のあと再取得して検証し、不一致なら非ゼロ終了する。
- Bot 起動時には同期しない（同期で消したコマンドが再起動で復活しないため）。

## 5. 旧→新 対応表

| 旧（mabubot-ops v0.2.1、本番スナップショット） | 新（mabubot-ops v1.0.0） | 備考 |
| --- | --- | --- |
| `src/index.ts` | `src/index.ts` | 同構成。コメント規約のみ刷新（ready イベントは clientReady へ追随） |
| `src/commands.ts` | `src/commands.ts` | 全8コマンドの定義・文言・オプション順は同一 |
| `src/sync-commands.ts` / `src/clear-commands.ts` | 同名 | 上書き同期・全削除の手順は同一 |
| `src/store.ts` | `src/store.ts` | テーブル定義・メソッド・移行処理は同一（本番 DB 互換） |
| `src/util.ts` | `src/util.ts` | パース規則・ID 生成・実行ログは同一 |
| `src/welcome.ts` | `src/welcome.ts` | 歓迎＋自動ロール（複数対応を含む） |
| `src/poll.ts` / `src/recruit.ts` / `src/timer.ts` | 同名 | 締切・再スケジュールの規則は同一 |
| `src/templates.ts` / `src/stats.ts` | 同名 | テンプレート9種・無害化・集計要約は同一 |
| `src/scheduler.ts` / `src/announce.ts` / `src/ops.ts` | 同名 | due 判定・冪等・レート制限・承認フローは同一 |
| `src/events.ts` | `src/events.ts` | 集計カウントとボタン振り分けは同一 |
| `src/backup.ts` / `src/watchdog.ts` / `src/presence-cycle.ts` | 同名 | バックアップ方式・判定ロジック・サイクル形式は同一 |
| `src/test/*.test.ts`（src 内、dist/test で実行） | `tests/*.test.ts`（ルート、dist/tests で実行） | mabubot の配置に統一。全テストを移植し、プレゼンス・サイクルのテストを追加 |
| バージョン 0.2.1 | 1.0.0 | 再実装にあわせて振り直し |
| 起動スクリプト `dist/index.js` | `dist/src/index.js` | テスト配置の統一に伴う rootDir 変更のため。ecosystem.config.cjs も追随 |

## 6. 開発手順

すべての変更は次の手順で main に取り込む（正本は CONTRIBUTING.md）。

1. Issue を作成する（テンプレート使用。目的・作業内容・完了条件を書く）
2. main からブランチを切る: `<type>/<issue番号>-<slug>`
3. 実装し、ローカルで `./build.sh`（型チェック・ビルド・テスト）が通ることを確認する
4. PR を作成し、本文に `Closes #<番号>` を入れて Issue と紐づける
5. CI が通ったら **Rebase and merge** で main に取り込み、ブランチを削除する

- コミットメッセージは Conventional Commits ＋ 英語の件名
- リリースは main 上でバージョンを上げ、タグ `vX.Y.Z` を打って GitHub Release を作る（ノートのみ、バイナリは添付しない）

## 7. テスト

- 配置: `tests/`（util / ops / backup / watchdog / presence-cycle）。`npm test` がビルドのうえで `node --test dist/tests/*.test.js` を実行する。
- 旧テスト（util.test.ts・ops.test.ts・backup.test.ts・watchdog.test.ts、計47件）は全件移植した。あわせてプレゼンス・サイクル（整形・位相・送信スケジュール）のテスト7件を追加し、合計54件。
- Discord 接続が必要な部分（コマンドハンドラ・イベント）は単体テストの対象外で、純粋ロジックとストアを検証範囲とする（旧実装と同じ切り分け）。

## 8. 判断記録

- **棚卸しの正は本番スナップショット（2026-11-28）**: 本番（台2）のコードを正として再実装の基準にした。
- **ゼロから再実装し 1.0.0 に振り直し（2026-11-28）**: 統一開発フローへの移行を機に、コード・コメント・ドキュメントを作り直した。振る舞いの同一性は、移植テストと旧実装との突き合わせで担保する。
- **テスト配置を tests/ に統一（2026-11-28）**: 旧実装は `src/test/` にテストを置き `dist/test/` で実行していた。mabubot（v1.0.0）に合わせ、ルートの `tests/` に移した（ビルド成果物は `dist/src/` と `dist/tests/`）。これに伴い起動スクリプトのパスも `dist/src/index.js` に変わり、ecosystem.config.cjs を追随させた（pm2 アプリ名 `mabubot-ops` と DB ファイル名は据え置き）。
- **CI は ci.yml のみに集約（2026-11-28）**: mabubot と同じく、CI 1本＋Dependabot に統一した。整形は CI の `format:check`（blocking）で担保する。
- **Node は 24 以上を前提（2026-11-28）**: `node:sqlite` がフラグなしで使える下限として engines を `>=24` のまま維持し、CI も Node 24 で実行する。ecosystem.config.cjs の Node 22 向けフラグ付与は互換のため残す。
- **保存形式・保存先は変更しない（2026-11-28）**: 本番 DB（`data/mabubot-ops.db`）をそのまま使えることが再実装の絶対条件のため、スキーマと既定パスは旧実装と同一にした。
- **開発手順を統一した（2026-11-28）**: Issue → ブランチ → PR → Rebase and merge、Conventional Commits＋英語、タグ＋Release（ノートのみ）を採用。導入自体はブートストラップ例外として Issue なしで取り込む。
