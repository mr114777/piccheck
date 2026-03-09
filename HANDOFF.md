# SELEKT 引き継ぎドキュメント
**作成日:** 2026-03-06

---

## プロジェクト概要
写真セレクトサービス「SELEKT」— カメラマンが写真をアップロードし、モデル/クライアントがブラウザ上で OK/保留/NG を付けてセレクトできるWebアプリ。

## リポジトリ
- **GitHub:** `https://github.com/mr114777/piccheck.git`
- **本番URL:** `https://mr114777.github.io/piccheck/`
- **API (Cloudflare Workers):** `https://selekt-api.mr-mail114.workers.dev`
- **ローカルパス:** `/Users/kondoukouichi/Documents/angra`

---

## 技術スタック
| コンポーネント | 技術 |
|---|---|
| フロントエンド | 単一HTMLファイル（CSS/JS埋め込み） |
| バックエンド | Cloudflare Workers (`worker/worker.js`) |
| ストレージ | Cloudflare R2 (`selekt-photos` バケット) |
| ユーザー管理 | Cloudflare KV (`USERS`) |
| ホスティング | GitHub Pages |
| デプロイ | `npx wrangler deploy`（workerディレクトリから） |

---

## ファイル構成
```
SELEKT_Upload.html    - 写真アップロード画面（グループ分け、AI判定、クラウド送信）
SELEKT_Select.html    - 写真セレクト画面（OK/保留/NG、拡大、DL、コメント）
SELEKT_Auth.html      - ログイン/認証画面
SELEKT_Dashboard.html - ダッシュボード（セッション管理）
SELEKT_LP.html        - ランディングページ
SELEKT_Pricing.html   - 料金ページ
worker/worker.js      - Cloudflare Workers API
worker/wrangler.toml  - Workers設定（プラン制限値など）
```

---

## 料金プラン
| | FREE | BASIC (¥980/月) | PRO (¥2,980/月) |
|---|---|---|---|
| ストレージ | 10GB | 50GB | 400GB |
| セッション数/月 | 3 | 10 | 無制限 |
| 写真上限/セッション | なし | なし | なし |
| 有効期間 | 15日 | 60日 | 120日 |
| ファイル上限 | 30MB/枚 | 30MB/枚 | 30MB/枚 |

---

## API エンドポイント（worker.js）
| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/auth/login` | ログイン |
| POST | `/api/auth/register` | 登録 |
| POST | `/api/session/create` | セッション作成 |
| GET | `/api/session/:id` | セッション情報取得 |
| PATCH | `/api/session/:id` | メタ更新（title/limits） |
| POST | `/api/session/:id/upload` | 写真アップロード |
| GET | `/api/session/:id/photo/:fname` | 写真取得 |
| GET | `/api/session/:id/thumb/:fname` | サムネイル取得 |
| DELETE | `/api/session/:id/photos` | 写真一括削除 |
| POST | `/api/session/:id/select` | セレクト結果送信 |
| GET | `/api/sessions` | セッション一覧 |

---

## 🐛 未解決バグ（最優先）

### 1. セレクト画面：プロジェクト名・希望セレクト数の編集が保持されない

**症状:** クリックしてpromptで値を入力すると一瞬表示されるが、消えてしまう（日付やデフォルト値に戻る）

**調査済みの原因:**
- `PATCH` メソッドを CORS `Access-Control-Allow-Methods` に追加済み（修正済み）
- Workerのデプロイ確認済み（curlでPATCH成功確認済み）
- `save()` 関数が未定義だった問題 → `saveState()`/`loadSavedState()` を定義済み
- `loadCloudSession` を `async/await` 化済み

**未解決の可能性:**
- **GitHub Pages のキャッシュ** — 古い `SELEKT_Select.html` がキャッシュされている可能性あり 
  - 確認方法: ブラウザでシークレットモードで `Ctrl+Shift+R` でキャッシュクリアしてアクセス
  - または `?v=2` パラメータを付けてアクセス
- `editSessionTitle()` 内の `prompt()` がブラウザで正常に動作しているか確認
- DevTools > Console でエラーが出ていないか確認
- `editSessionTitle()` 内で PATCH リクエストが実際に送信されているか network タブで確認

**関連コード:**
- `SELEKT_Select.html` L5095-5140: `editSessionTitle()`
- `SELEKT_Select.html` L3801-3845: `editGroupDesired()` / `editTotalDesired()`
- `SELEKT_Select.html` L3847-3907: `saveState()` / `loadSavedState()` / `syncLimitsToCloud()`
- `worker.js` L381-407: PATCH エンドポイント

### 2. セレクト画面：サムネイル非表示（特殊文字ファイル名）

**症状:** 拡大表示では見えるがサムネイルは空白
**修正済み:** CSS `background: url()` → `<img>` 要素に変更（コミット `ed8265b`）
**確認推奨:** 修正後にテストが必要

---

## 最近の変更履歴（直近15コミット）
```
e81f293 fix: add PATCH to CORS allowed methods, await cloud session load
cc23418 fix: define save/load state functions, persist edits + cloud sync
692e1e3 feat: make desired select count editable from sidebar
61615de fix: preserve pencil icon on title after cloud load
9d0b20b feat: enable project name editing with cloud sync + PATCH endpoint
903394e feat: add photo delete with confirmation dialog + backend DELETE
ed8265b Fix: use img element for thumbnails instead of CSS url()
281b461 LP: refine copy, SVG icons, sharper messaging
c270d67 Add SELEKT LP
4b2bbdd Select UI: hide nav hints, brighten modal text, restyle expiry
60fc850 Update photo limits: FREE 300, BASIC 800, PRO 1500
5895207 Add BASIC plan: 3-tier pricing, session limits, Pricing page
171f712 Fix session isolation: skip localStorage when ?session= present
647a1d0 Fix: FREE monthly 2GB, per-file limit 30MB
cd3e379 Add i18n (JA/EN/ZH) to Upload page
```

---

## デプロイ手順

### フロントエンド（GitHub Pages）
```bash
cd /Users/kondoukouichi/Documents/angra
git add -A && git commit -m "変更内容" && git push
```
→ GitHub Pages が自動的にデプロイ

### バックエンド（Cloudflare Workers）
```bash
cd /Users/kondoukouichi/Documents/angra/worker
npx wrangler deploy
```
→ `wrangler login` が必要な場合あり

---

## 別PCでの環境構築
```bash
# 1. リポジトリをクローン
git clone https://github.com/mr114777/piccheck.git angra
cd angra

# 2. Workerデプロイ用（バックエンド変更時のみ）
cd worker
npm install wrangler
npx wrangler login  # Cloudflareアカウントでログイン

# 3. 動作確認
# フロントはHTMLファイルを直接ブラウザで開くか、
# python3 -m http.server 8080 でローカルサーバー起動
```

---

## テスト用セッション
- URL: `https://mr114777.github.io/piccheck/SELEKT_Select.html?session=f6YGxpFb`
- 写真4枚のテストセッション
