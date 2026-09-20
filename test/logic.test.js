const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../src/Logic.js');

test('parseRequestBody: valid csp-report body (report-uri format)', () => {
  const body = JSON.stringify({
    'csp-report': {
      'document-uri': 'https://example.com/page',
      'blocked-uri': 'https://evil.com/script.js',
      'violated-directive': 'script-src',
    },
  });
  assert.deepEqual(parseRequestBody(body), [
    {
      'document-uri': 'https://example.com/page',
      'blocked-uri': 'https://evil.com/script.js',
      'violated-directive': 'script-src',
    },
  ]);
});

test('parseRequestBody: malformed JSON falls back to a single empty object', () => {
  assert.deepEqual(parseRequestBody('not json'), [{}]);
});

test('parseRequestBody: missing csp-report key falls back to a single empty object', () => {
  assert.deepEqual(parseRequestBody(JSON.stringify({ other: 'value' })), [{}]);
});

test('parseRequestBody: Reporting API single csp-violation report', () => {
  const body = JSON.stringify([
    {
      type: 'csp-violation',
      body: {
        documentURL: 'https://example.com/page',
        blockedURL: 'https://evil.com/script.js',
        effectiveDirective: 'script-src',
      },
    },
  ]);
  assert.deepEqual(parseRequestBody(body), [
    {
      'document-uri': 'https://example.com/page',
      'blocked-uri': 'https://evil.com/script.js',
      'violated-directive': 'script-src',
    },
  ]);
});

test('parseRequestBody: Reporting API batch with multiple csp-violation reports', () => {
  const body = JSON.stringify([
    {
      type: 'csp-violation',
      body: { documentURL: 'https://example.com/a', blockedURL: 'https://evil.com/a.js', effectiveDirective: 'script-src' },
    },
    {
      type: 'csp-violation',
      body: { documentURL: 'https://example.com/b', blockedURL: 'https://evil.com/b.js', effectiveDirective: 'style-src' },
    },
  ]);
  assert.deepEqual(parseRequestBody(body), [
    { 'document-uri': 'https://example.com/a', 'blocked-uri': 'https://evil.com/a.js', 'violated-directive': 'script-src' },
    { 'document-uri': 'https://example.com/b', 'blocked-uri': 'https://evil.com/b.js', 'violated-directive': 'style-src' },
  ]);
});

test('parseRequestBody: Reporting API entries with other report types are filtered out', () => {
  const body = JSON.stringify([
    { type: 'deprecation', body: { documentURL: 'https://example.com/page' } },
    {
      type: 'csp-violation',
      body: { documentURL: 'https://example.com/page', blockedURL: 'https://evil.com/script.js', effectiveDirective: 'script-src' },
    },
  ]);
  assert.deepEqual(parseRequestBody(body), [
    { 'document-uri': 'https://example.com/page', 'blocked-uri': 'https://evil.com/script.js', 'violated-directive': 'script-src' },
  ]);
});

test('parseRequestBody: Reporting API batch with no csp-violation entries falls back to a single empty object', () => {
  const body = JSON.stringify([{ type: 'deprecation', body: { documentURL: 'https://example.com/page' } }]);
  assert.deepEqual(parseRequestBody(body), [{}]);
});

test('parseRequestBody: Reporting API entry with missing/non-string body fields becomes empty strings', () => {
  const body = JSON.stringify([{ type: 'csp-violation', body: {} }]);
  assert.deepEqual(parseRequestBody(body), [
    { 'document-uri': '', 'blocked-uri': '', 'violated-directive': '' },
  ]);
});

test('extractViolationFields: extracts all three fields', () => {
  const fields = extractViolationFields({
    'document-uri': 'https://example.com/page',
    'blocked-uri': 'https://evil.com/script.js',
    'violated-directive': 'script-src',
  });
  assert.deepEqual(fields, {
    documentUri: 'https://example.com/page',
    blockedUri: 'https://evil.com/script.js',
    violatedDirective: 'script-src',
  });
});

test('extractViolationFields: missing fields become empty strings', () => {
  assert.deepEqual(extractViolationFields({}), {
    documentUri: '',
    blockedUri: '',
    violatedDirective: '',
  });
});

test('extractViolationFields: non-string fields become empty strings', () => {
  const fields = extractViolationFields({
    'document-uri': 123,
    'blocked-uri': null,
    'violated-directive': undefined,
  });
  assert.deepEqual(fields, {
    documentUri: '',
    blockedUri: '',
    violatedDirective: '',
  });
});

test('extractHostname: normal URL', () => {
  assert.equal(extractHostname('https://example.com/page'), 'example.com');
});

test('extractHostname: URL with port', () => {
  assert.equal(extractHostname('https://example.com:8443/page'), 'example.com');
});

test('extractHostname: URL with userinfo', () => {
  assert.equal(extractHostname('https://user:pass@example.com/page'), 'example.com');
});

test('extractHostname: IPv6 literal', () => {
  assert.equal(extractHostname('https://[2001:db8::1]:8443/page'), '2001:db8::1');
});

test('extractHostname: no scheme is invalid', () => {
  assert.equal(extractHostname('example.com/page'), null);
});

test('extractHostname: garbage string is invalid', () => {
  assert.equal(extractHostname('not a url'), null);
});

test('extractHostname: empty string is invalid', () => {
  assert.equal(extractHostname(''), null);
});

test('extractHostname: mixed-case host is lowercased', () => {
  assert.equal(extractHostname('https://Example.COM/page'), 'example.com');
});

test('buildAllowedDomainList: skips header row', () => {
  const values = [
    ['ホスト名', 'memo'],
    ['example.com', 'memo1'],
  ];
  assert.deepEqual(buildAllowedDomainList(values), ['example.com']);
});

test('buildAllowedDomainList: filters blank domain rows', () => {
  const values = [
    ['ホスト名', 'memo'],
    ['example.com', ''],
    ['', 'unused row'],
    ['  ', 'whitespace only'],
  ];
  assert.deepEqual(buildAllowedDomainList(values), ['example.com']);
});

test('buildAllowedDomainList: trims and lowercases', () => {
  const values = [
    ['ホスト名', 'memo'],
    [' Example.COM ', ''],
  ];
  assert.deepEqual(buildAllowedDomainList(values), ['example.com']);
});

test('isAllowedDomain: exact match is allowed', () => {
  assert.equal(isAllowedDomain('example.com', ['example.com', 'other.com']), true);
});

test('isAllowedDomain: unrelated domain is not allowed', () => {
  assert.equal(isAllowedDomain('unknown.com', ['example.com']), false);
});

test('isAllowedDomain: spoofed prefix domain is not allowed', () => {
  assert.equal(isAllowedDomain('evil-example.com', ['example.com']), false);
});

test('isAllowedDomain: spoofed suffix domain is not allowed', () => {
  assert.equal(isAllowedDomain('example.com.evil.com', ['example.com']), false);
});

test('isAllowedDomain: null hostname is not allowed', () => {
  assert.equal(isAllowedDomain(null, ['example.com']), false);
});

test('getVerdictLabel: allowed is 受理', () => {
  assert.equal(getVerdictLabel(true), '受理');
});

test('getVerdictLabel: not allowed is 拒否(未許可サイト)', () => {
  assert.equal(getVerdictLabel(false), '拒否(未許可サイト)');
});

test('buildViolationLogRow: builds the 4-column row', () => {
  const now = new Date('2026-09-19T00:00:00Z');
  const row = buildViolationLogRow(
    now,
    'https://example.com/page',
    'https://evil.com/script.js',
    'script-src'
  );
  assert.deepEqual(row, [
    now,
    'https://example.com/page',
    'https://evil.com/script.js',
    'script-src',
  ]);
});

test('buildSlackMessage: accepted template', () => {
  const message = buildSlackMessage(true, {
    documentUri: 'https://example.com/page',
    violatedDirective: 'script-src',
    blockedUri: 'https://evil.com/script.js',
  });
  assert.equal(
    message,
    '⚠️ CSP違反レポート受信\n' +
      'サイト: https://example.com/page\n' +
      'ディレクティブ: script-src\n' +
      'ブロックされたURI: https://evil.com/script.js'
  );
});

test('findRequestLogRowIndex: empty array returns -1', () => {
  assert.equal(findRequestLogRowIndex([], 'example.com'), -1);
});

test('findRequestLogRowIndex: match at index 0', () => {
  const rows = [
    ['example.com', new Date('2026-01-01'), new Date('2026-01-01')],
    ['other.com', new Date('2026-01-02'), new Date('2026-01-02')],
  ];
  assert.equal(findRequestLogRowIndex(rows, 'example.com'), 0);
});

test('findRequestLogRowIndex: match at last index', () => {
  const rows = [
    ['example.com', new Date('2026-01-01'), new Date('2026-01-01')],
    ['other.com', new Date('2026-01-02'), new Date('2026-01-02')],
  ];
  assert.equal(findRequestLogRowIndex(rows, 'other.com'), 1);
});

test('findRequestLogRowIndex: no match returns -1', () => {
  const rows = [['example.com', new Date('2026-01-01'), new Date('2026-01-01')]];
  assert.equal(findRequestLogRowIndex(rows, 'unknown.com'), -1);
});

test('buildRequestLogRow: allowed domain', () => {
  const created = new Date('2026-01-01T00:00:00Z');
  const updated = new Date('2026-01-02T00:00:00Z');
  assert.deepEqual(buildRequestLogRow('example.com', created, updated, true), [
    'example.com',
    created,
    updated,
    '受理',
  ]);
});

test('buildRequestLogRow: not allowed domain', () => {
  const created = new Date('2026-01-01T00:00:00Z');
  const updated = new Date('2026-01-02T00:00:00Z');
  assert.deepEqual(buildRequestLogRow('evil-example.com', created, updated, false), [
    'evil-example.com',
    created,
    updated,
    '拒否(未許可サイト)',
  ]);
});

test('buildSlackMessage: rejected template', () => {
  const message = buildSlackMessage(false, {
    documentUri: 'https://evil-example.com/page',
    violatedDirective: 'script-src',
    blockedUri: 'https://evil.com/script.js',
  });
  assert.equal(
    message,
    '⛔ 未許可サイトからのCSPレポート受信\n' +
      'サイト: https://evil-example.com/page\n' +
      'ディレクティブ: script-src\n' +
      'ブロックされたURI: https://evil.com/script.js'
  );
});
