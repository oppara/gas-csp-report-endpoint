const SHEET_NAMES = {
  ALLOWED: 'allowed_source_sites',
  VIOLATION_LOG: 'violation_log',
  REQUEST_LOG: 'request_log',
};

const SLACK_WEBHOOK_PROPERTY_KEY = 'SLACK_WEBHOOK_URL';

/**
 * CSP違反レポートを受信するWebアプリのエントリポイント。
 * `report-uri`形式(1件)・`report-to`(Reporting API)形式(複数件バッチ)のどちらも受け付け、
 * 含まれる各レポートを独立した違反として処理する。
 * 許可サイトからのレポートのみ「受理」とし`violation_log`に記録する(未許可サイトからのレポートは記録しない)。
 * `request_log`への記録とSlack通知は許可・未許可を問わず、レポートごとに毎回行う。
 * レスポンスは、バッチ内に1件でも未許可サイトからのレポートがあれば`rejected`、なければ`ok`。
 * 常にHTTP 200 + JSONレスポンスを返す。
 * @param {GoogleAppsScript.Events.DoPost} e - GASのdoPostイベントオブジェクト
 * @returns {GoogleAppsScript.Content.TextOutput} `{"status": "ok"|"rejected"}`を返すJSONレスポンス
 */
function doPost(e) {
  const now = new Date();
  const rawBody = (e && e.postData && e.postData.contents) || '';
  const cspReports = parseRequestBody(rawBody);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const allowedSheet = requireSheet_(ss, SHEET_NAMES.ALLOWED);
  const allowedDomains = buildAllowedDomainList(allowedSheet.getDataRange().getValues());
  const violationSheet = requireSheet_(ss, SHEET_NAMES.VIOLATION_LOG);

  let anyRejected = false;
  cspReports.forEach((cspReport) => {
    const fields = extractViolationFields(cspReport);
    const hostname = extractHostname(fields.documentUri);
    const isAllowed = isAllowedDomain(hostname, allowedDomains);
    if (!isAllowed) {
      anyRejected = true;
    }

    if (hostname) {
      upsertRequestLog_(ss, hostname, now, isAllowed);
    }

    if (isAllowed) {
      violationSheet.appendRow(
        buildViolationLogRow(now, fields.documentUri, fields.blockedUri, fields.violatedDirective)
      );
    }

    sendSlackNotification_(isAllowed, fields);
  });

  return ContentService
    .createTextOutput(JSON.stringify({ status: anyRejected ? 'rejected' : 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 指定名のシートを取得する。見つからない場合はエラーとする。
 * `allowed_source_sites`/`violation_log`は仕様上、欠如時にエラーとすることが明示されている。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - 対象スプレッドシート
 * @param {string} name - シート名
 * @returns {GoogleAppsScript.Spreadsheet.Sheet} 見つかったシート
 * @throws {Error} シートが存在しない場合
 */
function requireSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error('Sheet not found: ' + name);
  }
  return sheet;
}

/**
 * `request_log`シートに対して、ドメインをキーにupsertする。
 * 既存行があれば`updated`列と`種別`列を更新し(種別は毎回最新の判定で上書き)、
 * なければ`created`=`updated`=nowで新規追加する。
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss - 対象スプレッドシート
 * @param {string} domain - 検知したドメイン
 * @param {Date} now - 現在時刻
 * @param {boolean} isAllowed - 許可サイトからのレポートであれば`true`
 * @returns {void}
 */
function upsertRequestLog_(ss, domain, now, isAllowed) {
  const sheet = ss.getSheetByName(SHEET_NAMES.REQUEST_LOG);
  const values = sheet.getDataRange().getValues();
  const dataRows = values.slice(1);
  const rowIndex = findRequestLogRowIndex(dataRows, domain);
  if (rowIndex === -1) {
    sheet.appendRow(buildRequestLogRow(domain, now, now, isAllowed));
  } else {
    sheet.getRange(rowIndex + 2, 3, 1, 2).setValues([[now, getVerdictLabel(isAllowed)]]);
  }
}

/**
 * Slackにwebhook経由で通知する。Webhook URLが未設定の場合は何もしない。
 * 通知失敗が`doPost`全体を落とさないよう、ここでの例外はレスポンス生成をブロックしない想定。
 * @param {boolean} isAllowed - 許可サイトからのレポートであれば`true`
 * @param {{documentUri: string, violatedDirective: string, blockedUri: string}} fields - 違反レポートのフィールド
 * @returns {void}
 */
function sendSlackNotification_(isAllowed, fields) {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty(SLACK_WEBHOOK_PROPERTY_KEY);
  if (!webhookUrl) {
    return;
  }
  UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ text: buildSlackMessage(isAllowed, fields) }),
    muteHttpExceptions: true,
  });
}

/**
 * 手動検証用: 存在しないシート名を指定し、`requireSheet_`が例外をthrowすることを確認する。
 * Apps Scriptエディタから実行し、実行ログでエラーを確認する。
 * @returns {void}
 */
function manualTest_missingSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  requireSheet_(ss, 'this_sheet_does_not_exist');
}

/**
 * 手動検証用: 受理時のSlack通知テンプレートを実際に送信して目視確認する。
 * 事前にスクリプトプロパティ`SLACK_WEBHOOK_URL`の設定が必要。
 * @returns {void}
 */
function manualTest_accepted() {
  sendSlackNotification_(true, {
    documentUri: 'https://example.com/page',
    violatedDirective: 'script-src',
    blockedUri: 'https://evil.com/script.js',
  });
}

/**
 * 手動検証用: 拒否時のSlack通知テンプレートを実際に送信して目視確認する。
 * 事前にスクリプトプロパティ`SLACK_WEBHOOK_URL`の設定が必要。
 * @returns {void}
 */
function manualTest_rejected() {
  sendSlackNotification_(false, {
    documentUri: 'https://evil-example.com/page',
    violatedDirective: 'script-src',
    blockedUri: 'https://evil.com/script.js',
  });
}
