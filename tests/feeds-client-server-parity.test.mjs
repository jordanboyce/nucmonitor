/**
 * Feed parity test — client vs server (PR #3715 review follow-up).
 *
 * The client feed config (`src/config/feeds.ts`) and the server-side digest
 * feed config (`server/worldmonitor/news/v1/_feeds.ts`) are independent files
 * that frequently share feed NAMES. When a publisher dies and we fall back
 * to Google News on one side but forget to mirror the change on the other,
 * the digest path keeps fetching the dead URL while the direct-RSS path is
 * healthy (or vice versa) — exactly the Blockworks drift caught on #3715.
 *
 * This test fails when a feed NAME appears on both sides with INCONSISTENT
 * routing — i.e. client uses Google News while server uses a direct upstream
 * URL (or vice versa). It does NOT require URL byte-equality (server uses a
 * `gn()` helper with slightly different topic terms in places), only that
 * both sides agree on the "Google News fallback or direct fetch" question.
 *
 * KNOWN_DRIFTS grandfathers in feeds that already drift at the time this
 * test landed. Each is its own per-feed judgment (some intentionally use
 * Google News on one side because the direct URL recently broke). New drift
 * fails the test. The set should SHRINK over time as feeds get reconciled,
 * not grow.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const CLIENT_PATH = resolve(ROOT, 'src/config/feeds.ts');
const SERVER_PATH = resolve(ROOT, 'server/worldmonitor/news/v1/_feeds.ts');

/**
 * Extract feed name + a routing hint from a source file.
 *
 * Handles both shapes:
 *
 *     // inline
 *     { name: 'X', url: rss('https://...') },
 *     { name: 'Y', url: gn('site:y.com when:1d') },
 *
 *     // multiline with locale-keyed URL object (locale variants all use
 *     // direct rss/gn helpers, never mixed)
 *     {
 *       name: 'Z',
 *       url: {
 *         en: rss('...'),
 *         fr: rss('...'),
 *       },
 *     }
 *
 * The earlier single-line-only regex missed ~46 multiline entries on the
 * client side, which caused the orphan check below to falsely flag entries
 * that ARE on both sides (France 24, EuroNews, etc.) as server-only.
 *
 * Returns a Map<name, { isGoogleNews: boolean, snippet: string }>.
 */
function extractFeedRouting(filePath) {
  const src = readFileSync(filePath, 'utf-8');
  const out = new Map();
  const NAME_RE = /\bname:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = NAME_RE.exec(src)) !== null) {
    const [, name] = m;
    // Scan forward from this `name:` to find the matching `url:` — within
    // the next ~600 chars (enough to span a multiline locale-object url
    // without crossing into the sibling entry's name).
    const window = src.slice(m.index, m.index + 600);
    const urlMatch = window.match(/\burl:\s*([\s\S]*?)(?:,\s*$|}\s*[,\]])/m);
    if (!urlMatch) continue;
    const urlExpr = urlMatch[1];
    // Match the bare `gn(...)` helper AND any sibling like `gnLocale(...)` —
    // both emit `news.google.com/rss/search?...` URLs that the cache /
    // user-experience pipeline should treat identically. Don't widen this to
    // unrelated `gn*` identifiers; restrict to known prefixes that wrap GN.
    const isGN =
      /news\.google\.com\/rss\/search/i.test(urlExpr) ||
      /\bgn(?:Locale)?\s*\(/.test(urlExpr);
    // First-seen wins — names can repeat across categories (localized
    // variants etc.); the first definition is the canonical routing.
    if (!out.has(name)) {
      out.set(name, { isGoogleNews: isGN, snippet: urlExpr.trim().slice(0, 120) });
    }
  }
  return out;
}

const stringArgument = (expression, index) => {
  const argument = expression.arguments[index];
  return ts.isStringLiteralLike(argument) ? argument.text : null;
};

/**
 * Resolve a feed initializer to the upstream URL(s) it denotes. Locale-keyed
 * URL objects can intentionally contain more than one URL; callers compare
 * every returned member rather than silently choosing an English default.
 */
function extractUpstreamUrls(initializer) {
  if (ts.isStringLiteralLike(initializer)) return [initializer.text];

  if (ts.isObjectLiteralExpression(initializer)) {
    return initializer.properties.flatMap(property => {
      if (!ts.isPropertyAssignment(property)) return [];
      return extractUpstreamUrls(property.initializer);
    });
  }

  if (!ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)) return [];
  const helper = initializer.expression.text;
  if ((helper === 'rss' || helper === 'railwayRss') && initializer.arguments.length === 1) {
    const upstream = stringArgument(initializer, 0);
    return upstream === null ? [] : [upstream];
  }
  if (helper === 'gn' && initializer.arguments.length === 1) {
    const query = stringArgument(initializer, 0);
    return query === null
      ? []
      : [
          `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
        ];
  }
  if (helper === 'gnLocale' && initializer.arguments.length === 4) {
    const [query, hl, gl, ceid] = [0, 1, 2, 3].map(index => stringArgument(initializer, index));
    if ([query, hl, gl, ceid].some(value => value === null)) return [];
    return [
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${ceid}`,
    ];
  }
  return [];
}

function canonicalizeUpstreamUrl(upstream) {
  const url = new URL(upstream, 'https://api.worldmonitor.app');
  url.hash = '';
  url.host = url.host.toLowerCase();
  const parameters = [...url.searchParams.entries()].sort(([left], [right]) => left.localeCompare(right));
  url.search = '';
  for (const [name, value] of parameters) url.searchParams.append(name, value);
  return url.toString();
}

function findVariableInitializerInSource(source, filePath, variableName) {
  const ast = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let initializer = null;
  const visit = node => {
    if (
      initializer === null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      initializer = node.initializer ?? null;
    }
    if (initializer === null) ts.forEachChild(node, visit);
  };
  visit(ast);
  return initializer;
}

function findVariableInitializer(filePath, variableName) {
  return findVariableInitializerInSource(readFileSync(filePath, 'utf-8'), filePath, variableName);
}

/**
 * Extract the shipped catalog with enough context to compare URLs.
 *
 * The routing test above intentionally ignores query differences, but a shared
 * name whose sides point at different publishers is still two different feeds.
 * NucMonitor ships one dashboard, so the strict comparison is NUCLEAR_FEEDS
 * (client) versus VARIANT_FEEDS.nuclear (the digest the client requests). The
 * server's remaining `full` variant only feeds server-side headline search and
 * is never filtered by the client, so it is out of scope here.
 */
function extractShippedFeedsByCategory(filePath, side) {
  const initializer = findVariableInitializer(
    filePath,
    side === 'client' ? 'NUCLEAR_FEEDS' : 'VARIANT_FEEDS',
  );
  assert.ok(initializer, `Unable to locate the ${side} shipped feed declaration in ${filePath}`);
  const record = ts.isObjectLiteralExpression(initializer) ? initializer : null;
  if (side === 'server') {
    const nuclearVariant = record?.properties.find(
      property => ts.isPropertyAssignment(property) && property.name.getText() === 'nuclear',
    );
    assert.ok(ts.isPropertyAssignment(nuclearVariant), 'VARIANT_FEEDS must contain a nuclear variant');
    assert.ok(ts.isObjectLiteralExpression(nuclearVariant.initializer));
    return extractFeedRecord(nuclearVariant.initializer, filePath);
  }
  assert.ok(record);
  return extractFeedRecord(record, filePath);
}

function namesByCategory(feeds) {
  const out = new Map();
  for (const key of feeds.keys()) {
    const separator = key.indexOf(':');
    const category = key.slice(0, separator);
    const names = out.get(category) ?? new Set();
    names.add(key.slice(separator + 1));
    out.set(category, names);
  }
  return out;
}

function extractFeedRecord(record, filePath) {
  const out = new Map();
  for (const categoryProperty of record.properties) {
    assert.ok(
      ts.isPropertyAssignment(categoryProperty),
      `${filePath} feed catalog contains an unsupported category entry: ${categoryProperty.getText()}`,
    );
    const category = categoryProperty.name.getText().replace(/^['"]|['"]$/g, '');
    assert.ok(
      ts.isArrayLiteralExpression(categoryProperty.initializer),
      `${filePath} category ${category} must use an inline array literal`,
    );
    let parsedCount = 0;
    for (const element of categoryProperty.initializer.elements) {
      assert.ok(
        ts.isObjectLiteralExpression(element),
        `${filePath} category ${category} contains an unsupported feed entry: ${element.getText()}`,
      );
      const nameProperty = element.properties.find(property => {
        return (
          ts.isPropertyAssignment(property) &&
          property.name.getText().replace(/^['"]|['"]$/g, '') === 'name' &&
          ts.isStringLiteralLike(property.initializer)
        );
      });
      const urlProperty = element.properties.find(property => {
        return (
          ts.isPropertyAssignment(property) &&
          property.name.getText().replace(/^['"]|['"]$/g, '') === 'url'
        );
      });
      assert.ok(
        ts.isPropertyAssignment(nameProperty) && ts.isStringLiteralLike(nameProperty.initializer),
        `${filePath} category ${category} contains a feed without an inline string name`,
      );
      assert.ok(
        ts.isPropertyAssignment(urlProperty),
        `${filePath} feed ${category}:${nameProperty.initializer.text} has no inline URL`,
      );
      const name = nameProperty.initializer.text;
      const urls = extractUpstreamUrls(urlProperty.initializer).map(canonicalizeUpstreamUrl);
      if (urls.length === 0) {
        throw new Error(`Unable to resolve a URL for ${filePath} feed ${category}:${name}`);
      }
      const key = `${category}:${name}`;
      const existing = out.get(key) ?? new Set();
      for (const url of urls) existing.add(url);
      out.set(key, existing);
      parsedCount += 1;
    }
    assert.ok(parsedCount > 0, `No feeds parsed from ${filePath} category ${category}`);
  }
  return out;
}

function assertReasonedExceptions(exceptions, label) {
  for (const [key, reason] of exceptions) {
    assert.equal(typeof reason, 'string', `${label} ${key} must have a written reason`);
    assert.ok(reason.trim().length > 0, `${label} ${key} must have a written reason`);
  }
}

describe('feed parity: client vs server (PR #3715 follow-up)', () => {
  const client = extractFeedRouting(CLIENT_PATH);
  const server = extractFeedRouting(SERVER_PATH);

  it('extracted feeds from both files', () => {
    assert.ok(client.size > 0, 'client feed extraction must not be empty');
    assert.ok(server.size > 0, 'server feed extraction must not be empty');
    assert.ok(client.has('NRC News'), 'client feed extraction must retain the critical NRC News member');
    assert.ok(server.has('NRC News'), 'server feed extraction must retain the critical NRC News member');
  });

  // Snapshot of feeds that ALREADY drift between client and server at PR #3715
  // merge time. Each one is its own per-feed judgment (some intentionally use
  // Google News on one side because the direct URL recently broke). The test
  // fails for NEW drift, not historic drift. This set should SHRINK over time
  // as feeds get reconciled — not grow.
  // The World Monitor entries grandfathered here (The National, CSIS, DW News,
  // ...) left the client with the NucMonitor trim, so none is shared any more.
  const KNOWN_DRIFTS = new Set([]);

  it('every NEW shared feed name uses consistent routing (grandfathered drift snapshot)', () => {
    const newDrift = [];
    const resolvedKnown = [];
    for (const [name, c] of client) {
      const s = server.get(name);
      if (!s) continue;
      if (c.isGoogleNews === s.isGoogleNews) {
        if (KNOWN_DRIFTS.has(name)) resolvedKnown.push(name);
        continue;
      }
      if (KNOWN_DRIFTS.has(name)) continue; // grandfathered
      newDrift.push(
        `  - "${name}":\n` +
          `      client: ${c.isGoogleNews ? 'Google News' : 'direct'}  ${c.snippet.slice(0, 100)}\n` +
          `      server: ${s.isGoogleNews ? 'Google News' : 'direct'}  ${s.snippet.slice(0, 100)}`,
      );
    }
    assert.equal(
      newDrift.length,
      0,
      'NEW feed routing drift between client and server. Either update both sides ' +
        'or rename one entry so the parity check skips it:\n' +
        newDrift.join('\n'),
    );
    // If a previously-known drift is now consistent, the contributor should
    // remove it from KNOWN_DRIFTS — fail loudly so it gets cleaned up.
    assert.equal(
      resolvedKnown.length,
      0,
      `Drifts in KNOWN_DRIFTS are now consistent — remove from the set: ${resolvedKnown.join(', ')}`,
    );
  });

  it('REGRESSION (#3715): Blockworks does not appear on either side with a direct blockworks.co URL', () => {
    // The exact failure mode that prompted this test — server still pointed
    // at https://blockworks.co/feed after client moved to Google News, so the
    // digest path kept hitting Cloudflare-blocked upstream. Both sides have
    // since removed Blockworks (The Block covers the same territory). Lock
    // it in: a future contributor must not re-add the dead URL.
    for (const [path, label] of [[CLIENT_PATH, 'client'], [SERVER_PATH, 'server']]) {
      const src = readFileSync(path, 'utf-8');
      assert.ok(
        !/['"]https?:\/\/blockworks\.co\/feed['"]/.test(src),
        `${label} (${path}) still references the dead blockworks.co/feed URL`,
      );
    }
  });

  // Server-only feeds get aggregated, ranked, and TRUNCATED to
  // MAX_ITEMS_PER_CATEGORY in list-feed-digest.ts, THEN data-loader.ts filters
  // them by `enabledNames` from src/config/feeds.ts.
  // If the server emits a feed whose name has no client-side counterpart, the
  // server fetches it for nothing AND its items crowd out visible items in the
  // same category, shrinking the visible result set. Exactly the
  // Commodity-Trade-Mantra failure mode the #3717 reviewer caught.
  //
  it('every server feed has a client home in the same category before MAX_ITEMS_PER_CATEGORY truncation', () => {
    const clientByCategory = namesByCategory(extractShippedFeedsByCategory(CLIENT_PATH, 'client'));
    const serverByCategory = namesByCategory(extractShippedFeedsByCategory(SERVER_PATH, 'server'));
    const clientNameCount = [...clientByCategory.values()].reduce((sum, names) => sum + names.size, 0);
    const serverNameCount = [...serverByCategory.values()].reduce((sum, names) => sum + names.size, 0);
    assert.ok(clientNameCount > 0, 'client category parser must not be empty');
    assert.ok(serverNameCount > 0, 'server category parser must not be empty');
    const orphans = [];
    for (const [category, serverNames] of serverByCategory) {
      const clientNames = clientByCategory.get(category) ?? new Set();
      for (const name of serverNames) {
        if (!clientNames.has(name)) orphans.push(`${category}: ${name}`);
      }
    }
    assert.equal(
      orphans.length,
      0,
      'Server-only feed entries detected. The server will fetch these, ' +
        'rank them into MAX_ITEMS_PER_CATEGORY, then the client filter will ' +
        'drop them from that category — silently shrinking the visible result set. Either add a ' +
        'matching entry with the same name and category to src/config/feeds.ts, or remove ' +
        'the server entry:\n' +
        orphans.map(entry => `  - ${entry}`).join('\n'),
    );
  });

  it('REGRESSION (#3717): Commodity Trade Mantra is not on the server side', () => {
    // The #3717 reviewer caught this: I removed CTM from the client in #3715
    // but left it on the server, so the server fetched it, counted it toward
    // MAX_ITEMS_PER_CATEGORY, then the client filter dropped it — invisible
    // crowd-out. Lock it in.
    const src = readFileSync(SERVER_PATH, 'utf-8');
    assert.ok(
      !/name:\s*['"]Commodity Trade Mantra['"]/.test(src),
      `${SERVER_PATH} still has a 'Commodity Trade Mantra' entry — it has no client counterpart so its items get truncated-then-dropped`,
    );
  });

  // Catalog differences are deliberate or grandfathered with a
  // reason. New differences must either be aligned or get a new reviewed entry
  // here; silently adding another exception in product code is not allowed.
  // The World Monitor full-catalog exceptions went with that catalog; the
  // nuclear catalogs currently agree feed for feed.
  const INTENTIONAL_URL_DIVERGENCES = new Map([]);

  it('REGRESSION (#6427): shipped-feed extraction rejects unsupported catalog shapes', () => {
    const unsupportedCatalogs = [
      'const FULL_FEEDS = { ...baseCategories };',
      'const FULL_FEEDS = { us: sharedFeeds };',
      "const FULL_FEEDS = { us: [{ name: 'Inline', url: rss('https://example.com/feed') }, ...sharedFeeds] };",
    ];

    for (const [index, source] of unsupportedCatalogs.entries()) {
      const filePath = `unsupported-full-feeds-${index}.ts`;
      const initializer = findVariableInitializerInSource(source, filePath, 'FULL_FEEDS');
      assert.ok(ts.isObjectLiteralExpression(initializer));
      assert.throws(
        () => extractFeedRecord(initializer, filePath),
        /unsupported category entry|must use an inline array literal|unsupported feed entry/,
      );
    }
  });

  it('REGRESSION (#6427): parity exceptions require written reasons', () => {
    assertReasonedExceptions(INTENTIONAL_URL_DIVERGENCES, 'URL-divergence exception');
    assert.throws(
      () => assertReasonedExceptions(new Map([['us:Example', '   ']]), 'test exception'),
      /must have a written reason/,
    );
  });

  it('REGRESSION (#6427): shared shipped feeds resolve to the same upstream', () => {
    assertReasonedExceptions(INTENTIONAL_URL_DIVERGENCES, 'URL-divergence exception');
    const clientFullFeeds = extractShippedFeedsByCategory(CLIENT_PATH, 'client');
    const serverFullFeeds = extractShippedFeedsByCategory(SERVER_PATH, 'server');
    assert.ok(clientFullFeeds.size > 0);
    assert.ok(serverFullFeeds.size > 0);

    const differences = [];
    const resolvedExceptions = [];
    for (const [key, clientUrls] of clientFullFeeds) {
      const serverUrls = serverFullFeeds.get(key);
      if (!serverUrls) continue;
      const isSame =
        clientUrls.size === serverUrls.size && [...clientUrls].every(url => serverUrls.has(url));
      if (isSame) {
        if (INTENTIONAL_URL_DIVERGENCES.has(key)) resolvedExceptions.push(key);
        continue;
      }
      if (INTENTIONAL_URL_DIVERGENCES.has(key)) continue;
      differences.push(
        `  - ${key}\n      client: ${[...clientUrls].join(', ')}\n      server: ${[...serverUrls].join(', ')}`,
      );
    }
    assert.equal(
      differences.length,
      0,
      'Shared feed names point at different upstreams. Align both sides, or add a reviewed reason to INTENTIONAL_URL_DIVERGENCES:\n' +
        differences.join('\n'),
    );
    assert.equal(
      resolvedExceptions.length,
      0,
      `URL-divergence exceptions are now aligned — remove them: ${resolvedExceptions.join(', ')}`,
    );
    const staleExceptions = [...INTENTIONAL_URL_DIVERGENCES.keys()].filter(
      key => !clientFullFeeds.has(key) || !serverFullFeeds.has(key),
    );
    assert.equal(
      staleExceptions.length,
      0,
      `URL-divergence exceptions no longer describe a shared feed — remove them: ${staleExceptions.join(', ')}`,
    );
  });

  it('REGRESSION (#6427): new client-only shipped feeds require a reviewed server decision', () => {
    const clientFullFeeds = extractShippedFeedsByCategory(CLIENT_PATH, 'client');
    const serverFullFeeds = extractShippedFeedsByCategory(SERVER_PATH, 'server');
    const INTENTIONAL_CLIENT_ONLY = new Map([]);
    assertReasonedExceptions(INTENTIONAL_CLIENT_ONLY, 'client-only exception');
    const unreviewed = [];
    for (const key of clientFullFeeds.keys()) {
      if (serverFullFeeds.has(key) || INTENTIONAL_CLIENT_ONLY.has(key)) continue;
      unreviewed.push(key);
    }
    const staleClientOnly = [...INTENTIONAL_CLIENT_ONLY.keys()].filter(
      key => !clientFullFeeds.has(key) || serverFullFeeds.has(key),
    );
    assert.equal(
      unreviewed.length,
      0,
      'Client-only feeds are invisible to the server digest. Add the feed to both sides, or record a reviewed client-only decision:\n' +
        unreviewed.map(key => `  - ${key}: ${INTENTIONAL_CLIENT_ONLY.get(key) ?? ''}`).join('\n'),
    );
    assert.equal(
      staleClientOnly.length,
      0,
      `Client-only exceptions are no longer client-only — remove them: ${staleClientOnly.join(', ')}`,
    );
  });
});
