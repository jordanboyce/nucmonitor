import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');
const apiRoot = join(root, 'api');
const sourceExtensions = new Set(['.js', '.ts']);
const ignoredFiles = new Set(['_sentry-common.js', '_sentry-edge.js', '_sentry-node.js']);

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (sourceExtensions.has(extname(entry.name)) && !entry.name.includes('.test.')) files.push(path);
  }
  return files;
}

function callEnd(source, openIndex) {
  let depth = 0;
  let quote = null;
  let template = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === '`') {
      template = !template;
      continue;
    }
    if (template) continue;
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return i + 1;
  }
  throw new Error(`unclosed call at ${openIndex}`);
}

// A renamed binding (`captureSilentError as capture`, `{ captureSilentError: capture }`)
// would otherwise escape a literal-name scan.
function captureNames(source) {
  const names = new Set(['captureSilentError']);
  for (const [, alias] of source.matchAll(/\bcaptureSilentError\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(alias);
  for (const [, alias] of source.matchAll(/\bcaptureSilentError\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) names.add(alias);
  return [...names];
}

function captures(source) {
  const calls = [];
  const marker = new RegExp(`(?<![\\w$])(?:${captureNames(source).join('|')})\\s*\\(`, 'g');
  let match;
  while ((match = marker.exec(source))) {
    const openIndex = source.indexOf('(', match.index);
    const end = callEnd(source, openIndex);
    calls.push(source.slice(match.index, end));
    marker.lastIndex = end;
  }
  return calls;
}

const allowedFingerprintHelpers = new Set([
  'mcpErrorFingerprint',
  'passkeyOfferFingerprint',
  'rssProxyErrorFingerprint',
]);

function fingerprintViolation(call) {
  const match = call.match(/\bfingerprint\s*:\s*/);
  if (!match) return 'missing fingerprint';
  const value = call.slice(match.index + match[0].length).trimStart();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return 'unterminated fingerprint array';
    const tuple = value.slice(0, end + 1);
    if (/^\[\s*\]$/.test(tuple)) return 'empty fingerprint array';
    const expressions = tuple.replace(/(['"])(?:\\.|(?!\1).)*\1/g, '');
    if (/\b(?:url|userId|token|requestId|message|status|q|query|issueSlot|label|page|host|targetHost|path|targetPath|email)\b/i.test(expressions)) {
      return `high-cardinality fingerprint value: ${tuple}`;
    }
    return null;
  }
  const helper = value.match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1];
  if (helper && allowedFingerprintHelpers.has(helper)) return null;
  return `fingerprint must be an inline array or approved domain helper: ${value.slice(0, 80)}`;
}

test('fingerprint guard rejects malformed and high-cardinality policies', () => {
  assert.match(fingerprintViolation('captureSilentError(err, { fingerprint: [] })'), /empty/);
  assert.match(fingerprintViolation('captureSilentError(err, { fingerprint: fingerprint })'), /inline array/);
  assert.match(
    fingerprintViolation("captureSilentError(err, { fingerprint: ['api/x', request.url, 'Error'] })"),
    /high-cardinality/,
  );
  assert.equal(
    fingerprintViolation("captureSilentError(err, { fingerprint: ['api/x', sentryStep, err.name] })"),
    null,
  );
  assert.equal(
    fingerprintViolation("captureSilentError(err, { fingerprint: mcpErrorFingerprint('tool-execution', tool.name, err) })"),
    null,
  );
  for (const value of ['q', 'query', 'issueSlot', 'label', 'page', 'targetHost', 'meta.targetPath', 'email']) {
    assert.match(
      fingerprintViolation(`captureSilentError(err, { fingerprint: ['api/x', ${value}, 'Error'] })`) ?? '',
      /high-cardinality/,
      `${value} must not be accepted as a fingerprint value`,
    );
  }
});

test('fingerprint guard follows renamed capture bindings', () => {
  const imported = "import { captureSilentError as capture } from './_sentry-edge.js';\ncapture(err, { tags: {} });";
  assert.deepEqual(captures(imported), ['capture(err, { tags: {} })']);
  const destructured = "const { captureSilentError: report } = deps;\nreport(err, { fingerprint: ['api/x', 'y', 'Error'] });";
  assert.deepEqual(captures(destructured), ["report(err, { fingerprint: ['api/x', 'y', 'Error'] })"]);
});

test('fingerprint guard catches a mutated production call', async () => {
  const source = await readFile(join(apiRoot, '_relay.js'), 'utf8');
  assert.ok(
    source.includes("fingerprint: ['api/_relay', 'relay-fetch'"),
    'mutation target moved: repoint this test at a current production fingerprint',
  );
  const mutated = source.replace(
    /fingerprint:\s*\['api\/_relay', 'relay-fetch', error instanceof Error \? error\.name : 'Error'\]/,
    "fingerprint: ['api/_relay', request.url, 'Error']",
  );
  assert.notEqual(mutated, source, 'mutation must target an existing production fingerprint');
  const [call] = captures(mutated).filter((value) => value.includes('fingerprint:'));
  assert.match(fingerprintViolation(call), /high-cardinality/);
});
