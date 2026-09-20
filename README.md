# gas-csp-report-endpoint

CSP(Content-Security-Policy)の `report-to`/`report-uri` で送られてくるレポートを受信し、許可された送信元サイトからのものだけを記録・Slack 通知する、Google Apps Script(GAS)製の Web アプリケーション。

詳細な仕様は[docs/spec.md](docs/spec.md)を参照。

## 構成

```
src/
  appsscript.json  - GASマニフェスト(V8ランタイム、タイムゾーン設定など)
  Logic.js         - GAS APIに依存しない関数群(ローカルテスト対象)
  Code.js          - doPost本体とGASサービス呼び出しの配線
test/
  logic.test.js    - Logic.jsのユニットテスト(node:test)
docs/
  spec.md          - 実装仕様書
e2e-html/
  index.html       - report-uri/report-to をブラウザから手動検証するページ
  .htaccess        - 検証用CSPヘッダーの設定サンプル(Apache + mod_headers)
```

`Logic.js` は末尾の `module.exports` ガードにより、
GAS(グローバル関数)と Node(`require`)の両方で同一コードが動く。

`Code.js` は GAS 専用で、
GAS サービス(`SpreadsheetApp`/`UrlFetchApp`/`PropertiesService`/`ContentService`)の呼び出しのみを担い、
判定・整形は `Logic.js` に委譲する。

## セットアップ

1. コンテナバインドする Google スプレッドシートを用意し、
   以下 3 シートを仕様書のとおりの列構成で作成する。
   - `allowed_source_sites`(ホスト名, memo)
   - `violation_log`(受信日時, document-uri, blocked-uri, violated-directive)
   - `request_log`(ホスト名, 初回アクセス日時, 最終アクセス日時, 種別)
2. Apps Script エディタの「プロジェクトの設定」→「スクリプト プロパティ」に、
   Slack Incoming Webhook の URL を `SLACK_WEBHOOK_URL` というキー名で登録する(コードに直接書かない)。
3. `.clasp.example.json` を参考に `.clasp.json` を作成し、
   `scriptId` と `parentId`(スプレッドシートの ID)を設定する(`.clasp.json` は `.gitignore` 対象)。

## デプロイ

1. `clasp push` でコードをプッシュする。
2. (初回のみ)Apps Script エディタから「デプロイ」→「新しいデプロイ」→種類「Web アプリケーション」を選択する。
3. 「次のユーザーとして実行: 自分」「アクセスできるユーザー: 全員」でデプロイする。
4. 発行された `https://script.google.com/macros/s/xxxxx/exec` を、
   CSP の `report-to`(および `report-uri`)エンドポイントに設定する。

「新しいデプロイ」は実行のたびにデプロイ ID が変わり URL も変わる。2 回目以降のコード反映は「デプロイを管理」から既存デプロイを選び、バージョンを更新する(URL を維持したまま更新できる)。

`make deploy` でも同様のことができる。`clasp push` 後、既存デプロイがあれば
`clasp deploy --deploymentId <ID>` でバージョン更新(URL 維持)、なければ `clasp deploy` で新規デプロイする。

## テスト

`Logic.js` の関数は Node 標準の `node:test` でテストする(追加の依存関係なし)。

```sh
node --test test/logic.test.js
```

`Code.js`(`doPost` 本体)は GAS 実行環境に依存するため自動テスト対象外。

`manualTest_missingSheet`/`manualTest_accepted`/`manualTest_rejected` を
Apps Script エディタから実行して手動検証する。

## ブラウザでの動作確認(e2e-html)

- `e2e-html/index.html` は、実際にブラウザから CSP 違反を発生させてエンドポイントに届くかを確認するためのページ。
- `.htaccess` は Apache + `mod_headers` 向けの設定サンプル。
- `.htaccess` 内の `https://script.google.com/macros/s/xxxxx/exec` は実際のデプロイ URL に差し替えて使う。
