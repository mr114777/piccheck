# SELEKT — プロジェクトコンテキスト

## 概要
写真セレクト共有サービス。カメラマンが写真をアップロードし、モデル/クライアントがOK/保留/NGでセレクトする。

## 技術スタック
- フロント: 単一HTMLファイル（CSS/JS埋込み）、GitHub Pages
- バックエンド: Cloudflare Workers (`worker/worker.js`)
- ストレージ: Cloudflare R2 (`selekt-photos`)
- ユーザー管理: Cloudflare KV (`USERS`)
- 認証: Supabase Auth（プライマリ） + カスタムJWT（worker.js API用）のブリッジ方式
- 本番: https://mr114777.github.io/piccheck/
- API: https://selekt-api.mr-mail114.workers.dev

## 料金プラン（Pricing.html準拠）
| | FREE | BASIC ¥980/月 | PRO ¥2,980/月 |
|---|---|---|---|
| ストレージ | 10GB | 50GB | 300GB |
| セッション/月 | 3 | 10 | 無制限 |
| 写真上限 | なし | なし | なし |
| 有効期間 | 10日 | 30日 | 90日 |

## 2026-03-29 コードレビュー＆修正（コミット 4046bf3）

### 修正済み
**バックエンド (worker.js):**
- パストラバーサル対策（sanitizeFname）
- CORS origin完全一致チェック
- PATCH/DELETE/Upload/写真削除に作成者認証追加
- パスワードハッシュ PBKDF2化（レガシー自動マイグレーション付き）
- ストレージ使用量追跡・制限
- viewToken漏洩防止
- ルート競合修正（/api/user/search）
- link-session認可バイパス修正
- プロフィール入力長さ制限

**フロントエンド（全HTMLファイル）:**
- XSS修正（innerHTML → createElement/escHtml）全ページ
- Select.html: 未定義関数_applyScale修正、renderGroupバグ、キーボード二重発火除去、postMessage origin検証、既知バグ#1（タイトル編集保持）、既知バグ#2（特殊文字サムネイル）
- Upload.html: Blob URLメモリリーク修正、重複検出改善、グループリミットデフォルト修正
- Dashboard.html: filterProjects event引数、userMenu null参照、認証ヘッダー追加
- Profile/Pricing: signOut未定義修正、i18nキー統一（selekt_lang）
- Setup.html: ロール名 business→company
- LP.html: モバイルハンバーガーメニュー追加、copyright年修正、料金プラン値統一
- Login.html → Auth.htmlリダイレクト
- supabase-config.js: signOutでlocalStorageクリア、ブリッジ認証、requireAuth改善

### 未完了タスク（次回優先）
1. **worker.js デプロイ** — `cd worker && npx wrangler deploy`
2. **Supabase anon key** を正しい値に差し替え（supabase-config.js）
3. **動作テスト** — ログイン、アップロード、セレクト画面の編集保持確認

## デプロイ手順
```bash
# フロント（GitHub Pages）
git push  # 自動デプロイ

# バックエンド（Cloudflare Workers）
cd worker
npx wrangler deploy
```
