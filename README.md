# Gmail自動削除 Chrome拡張 (MV3)

未読 / 既読を選択してGmailをチェックし、ゴミ箱送り or 完全削除する拡張機能。
手動チェック＋削除と、定期自動削除の両方に対応。

## ファイル
- `manifest.json` : MV3設定・OAuth・権限（サイドバー対応）
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` : サイドバーUI（全件チェック→全件削除→自動設定）
- `popup.html` / `popup.css` / `popup.js` : 旧ポップアップ（予備、現在は未使用）
- `background.js` : 定期自動削除 (chrome.alarms + Gmail API、全件処理)

## 使い方概要
1. Google CloudでOAuthクライアントIDを取得（下記）
2. `manifest.json` の `YOUR_CLIENT_ID` を置き換え
3. `chrome://extensions` で「デベロッパーモードON」→「パッケージ化されていない拡張機能を読み込む」→このフォルダを選択
4. ツールバーの拡張アイコン→サイドバーが開く→「ログイン」
5. 未読/既読・送信者・件名・日数などで条件選択→「全件チェック」→内容確認→「条件一致を全件削除」

## Google Cloud 設定手順（必須）
Gmail APIを使うため、自分のGoogleアカウントで1回だけ設定が必要：

1. https://console.cloud.google.com/ でプロジェクト作成
2. 「APIとサービス」→「ライブラリ」→「Gmail API」を有効化
3. 「APIとサービス」→「OAuth同意画面」→ External / テストユーザーに自分のGmailを追加
   - スコープに `https://www.googleapis.com/auth/gmail.modify` を追加
4. 「認証情報」→「認証情報を作成」→「OAuthクライアントID」→種類は **Chrome拡張機能**
   - アイテムID欄には、拡張を一度読み込んだ後に表示される拡張ID（chrome://extensions）を入力
5. 発行されたクライアントID（`xxx.apps.googleusercontent.com`）を `manifest.json` の `oauth2.client_id` に貼り付け
6. 拡張を「再読み込み」

※ 公開しない個人利用ならテストモードのままでOK。トークン期限切れ時は再ログイン。

## 検索式の例
- 未読のみ受信トレイ: `in:inbox is:unread`
- 既読のみ: `in:inbox is:read`
- 特定送信者の未読: `in:inbox is:unread from:mail@example.com`
- 30日より古い既読: `in:inbox is:read older_than:30d`

## 安全装置
- 空クエリの自動削除はスキップ（手動も二重confirm）
- 削除前に件数＋条件表示でconfirm確認（完全削除は二重確認）
- デフォルトはゴミ箱送り（30日間は復元可）
- チェック結果の詳細は先頭30件まで表示（全件が削除対象）
- 取得は手動2万件・自動5000件で安全停止、停止ボタンあり

## 注意
- 完全削除は復元不可。自己責任で。
- 大量削除はGmail API制限に注意（500件/ページで全ページ取得、削除は並列5件ずつ実行）。
