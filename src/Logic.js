/**
 * Reporting API(`report-to`)のバッチ配列から、`csp-violation`タイプのレポートのみを取り出し、
 * 旧`report-uri`形式(`document-uri`/`blocked-uri`/`violated-directive`)のキー名に正規化する。
 * @param {Array} reportingApiBatch - Reporting APIのPOSTボディ(配列)
 * @returns {Array<object>} 正規化されたcsp-report形状のオブジェクトの配列(該当なしなら空配列)
 */
function normalizeReportingApiBatch_(reportingApiBatch) {
  return reportingApiBatch
    .filter((entry) => entry && typeof entry === 'object' && entry.type === 'csp-violation' && entry.body && typeof entry.body === 'object')
    .map((entry) => ({
      'document-uri': typeof entry.body.documentURL === 'string' ? entry.body.documentURL : '',
      'blocked-uri': typeof entry.body.blockedURL === 'string' ? entry.body.blockedURL : '',
      'violated-directive': typeof entry.body.effectiveDirective === 'string' ? entry.body.effectiveDirective : '',
    }));
}

/**
 * リクエストボディをJSONとしてパースし、`csp-report`形状のオブジェクトの配列を返す。
 * `report-uri`形式(`{"csp-report": {...}}`)と`report-to`(Reporting API)形式
 * (`[{"type": "csp-violation", "body": {...}}, ...]`、複数バッチ対応)の両方を受け付ける。
 * パース失敗・非対応形式・該当レポートなしはすべて`[{}]`にフォールバックする。
 * @param {string} rawBody - リクエストボディの生文字列
 * @returns {Array<object>} 処理対象のcsp-report形状オブジェクトの配列(常に1件以上)
 */
function parseRequestBody(rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (err) {
    return [{}];
  }
  if (Array.isArray(parsed)) {
    const reports = normalizeReportingApiBatch_(parsed);
    return reports.length > 0 ? reports : [{}];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [{}];
  }
  const cspReport = parsed['csp-report'];
  if (!cspReport || typeof cspReport !== 'object') {
    return [{}];
  }
  return [cspReport];
}

/**
 * csp-reportオブジェクトから違反レポートに必要な3フィールドを取り出す。
 * 値が文字列でない(欠如・型不正)場合は空文字列にする。
 * @param {object} cspReport - `parseRequestBody`が返すcsp-reportオブジェクト
 * @returns {{documentUri: string, blockedUri: string, violatedDirective: string}}
 */
function extractViolationFields(cspReport) {
  return {
    documentUri: typeof cspReport['document-uri'] === 'string' ? cspReport['document-uri'] : '',
    blockedUri: typeof cspReport['blocked-uri'] === 'string' ? cspReport['blocked-uri'] : '',
    violatedDirective: typeof cspReport['violated-directive'] === 'string' ? cspReport['violated-directive'] : '',
  };
}

/**
 * URI文字列からホスト名を抽出する。
 * GAS V8ランタイムはグローバル`URL`クラスを提供しないため正規表現で自前実装している。
 * スキームが無い・パースできない場合は`null`を返す。ポート・userinfo・IPv6の`[]`は除去し、小文字化する。
 * @param {string} uriString - `document-uri`などの絶対URI文字列
 * @returns {string|null} ホスト名、または抽出失敗時`null`
 */
function extractHostname(uriString) {
  if (typeof uriString !== 'string') {
    return null;
  }
  const match = uriString.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^/?#:]+)/);
  if (!match) {
    return null;
  }
  let host = match[1];
  if (host.charAt(0) === '[') {
    host = host.slice(1, -1);
  }
  return host.toLowerCase();
}

/**
 * `allowed_source_sites`シートの生データ(ヘッダー行含む2次元配列)から、
 * 許可ドメイン一覧を作成する。ヘッダー行・空のdomain行は除外し、trim・小文字化する。
 * @param {Array<Array<*>>} sheetValues - シートの`getDataRange().getValues()`結果
 * @returns {string[]} 許可ドメイン(小文字・trim済み)の一覧
 */
function buildAllowedDomainList(sheetValues) {
  return sheetValues
    .slice(1)
    .map((row) => row[0])
    .filter((domain) => typeof domain === 'string' && domain.trim() !== '')
    .map((domain) => domain.trim().toLowerCase());
}

/**
 * ホスト名が許可ドメイン一覧に完全一致するか判定する。
 * 部分一致・includes判定は行わない(偽装ドメインの誤許可を防ぐため)。
 * @param {string|null} hostname - 判定対象のホスト名
 * @param {string[]} allowedDomains - `buildAllowedDomainList`が返す許可ドメイン一覧
 * @returns {boolean} 完全一致すれば`true`
 */
function isAllowedDomain(hostname, allowedDomains) {
  return allowedDomains.indexOf(hostname) !== -1;
}

/**
 * 判定結果に対応する`violation_log`用のラベル文字列を返す。
 * @param {boolean} isAllowed - 許可サイトからのレポートであれば`true`
 * @returns {string} `'受理'`または`'拒否(未許可サイト)'`
 */
function getVerdictLabel(isAllowed) {
  return isAllowed ? '受理' : '拒否(未許可サイト)';
}

/**
 * `violation_log`シートに追記する1行分の配列を組み立てる。
 * このシートには許可サイトからの受理レポートのみ記録するため、判定結果列は持たない。
 * @param {Date} now - 受信日時
 * @param {string} documentUri - 違反が発生したページのURL
 * @param {string} blockedUri - ブロックされたリソースのURI
 * @param {string} violatedDirective - 違反したディレクティブ
 * @returns {Array} `[受信日時, document-uri, blocked-uri, violated-directive]`
 */
function buildViolationLogRow(now, documentUri, blockedUri, violatedDirective) {
  return [now, documentUri, blockedUri, violatedDirective];
}

/**
 * Slack通知本文を組み立てる。受理・拒否で異なるテンプレートを使う。
 * @param {boolean} isAllowed - 許可サイトからのレポートであれば`true`
 * @param {{documentUri: string, violatedDirective: string, blockedUri: string}} fields - 違反レポートのフィールド
 * @returns {string} Slackに送信する通知本文
 */
function buildSlackMessage(isAllowed, fields) {
  const title = isAllowed ? '⚠️ CSP違反レポート受信' : '⛔ 未許可サイトからのCSPレポート受信';
  return [
    title,
    'サイト: ' + fields.documentUri,
    'ディレクティブ: ' + fields.violatedDirective,
    'ブロックされたURI: ' + fields.blockedUri,
  ].join('\n');
}

/**
 * `request_log`シートのデータ行(ヘッダーを除く2次元配列)から、
 * 指定ドメインと一致する行のindexを探す。
 * @param {Array<Array<*>>} dataRows - ヘッダー行を除いたシートデータ
 * @param {string} domain - 検索対象のドメイン
 * @returns {number} 一致した行のindex、見つからなければ`-1`
 */
function findRequestLogRowIndex(dataRows, domain) {
  for (let i = 0; i < dataRows.length; i++) {
    if (dataRows[i][0] === domain) {
      return i;
    }
  }
  return -1;
}

/**
 * `request_log`シートに書き込む1行分の配列を組み立てる。
 * 種別列には、その時点の判定結果(受理/拒否)を毎回上書きする想定の値を入れる。
 * @param {string} domain - 検知したドメイン
 * @param {Date} createdAt - 初回検知日時
 * @param {Date} updatedAt - 直近検知日時
 * @param {boolean} isAllowed - 許可サイトからのレポートであれば`true`
 * @returns {Array} `[domain, created, updated, 種別]`
 */
function buildRequestLogRow(domain, createdAt, updatedAt, isAllowed) {
  return [domain, createdAt, updatedAt, getVerdictLabel(isAllowed)];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseRequestBody,
    extractViolationFields,
    extractHostname,
    buildAllowedDomainList,
    isAllowedDomain,
    getVerdictLabel,
    buildViolationLogRow,
    buildSlackMessage,
    findRequestLogRowIndex,
    buildRequestLogRow,
  };
}
