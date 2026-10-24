import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { isPublicFeedHostname, isPublicFeedUrl, looksLikeFeedXml } from './_public-feed-host.js';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const TEST_KEY = 'rss-custom-test-key';
process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
const { default: handler } = await import('./rss-proxy.js');
const { __resetRateLimitForTest } = await import('./_rate-limit.js');

const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title><item><title>A</title></item></channel></rss>';

beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.WS_RELAY_URL;
  __resetRateLimitForTest();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});

function makeRequest(feedUrl, { custom = true } = {}) {
  const params = new URLSearchParams({ url: feedUrl });
  if (custom) params.set('custom', '1');
  return new Request(`https://nucmonitor.vercel.app/api/rss-proxy?${params}`, {
    headers: { Origin: 'https://nucmonitor.vercel.app', 'X-WorldMonitor-Key': TEST_KEY },
  });
}

function spyFetch(respond) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push(String(input));
    return respond(String(input), init, calls);
  };
  return calls;
}

describe('isPublicFeedHostname', () => {
  test('accepts ordinary public domain names', () => {
    for (const host of ['example.com', 'www.ans.org', 'news.energy.gov', 'a-b.co.uk', 'xn--bcher-kva.org']) {
      assert.equal(isPublicFeedHostname(host), true, host);
    }
  });

  test('refuses local, private, metadata and literal targets', () => {
    for (const host of [
      'localhost', 'app.localhost', 'printer.local', 'db.internal', 'metadata.google.internal',
      'router.lan', 'nas.home.arpa', 'intranet', '127.0.0.1', '10.0.0.5', '169.254.169.254',
      '2130706433', '[::1]', '::1', '0x7f.0.0.1', 'foo.test', 'site.invalid', '', 'a..b',
      '-bad.com', 'bad-.com',
    ]) {
      assert.equal(isPublicFeedHostname(host), false, host);
    }
  });

  test('isPublicFeedUrl also requires http(s), the default port and no credentials', () => {
    assert.equal(isPublicFeedUrl(new URL('https://example.com/feed')), true);
    assert.equal(isPublicFeedUrl(new URL('http://example.com/feed')), true);
    assert.equal(isPublicFeedUrl(new URL('https://example.com:8443/feed')), false);
    assert.equal(isPublicFeedUrl(new URL('https://user:pw@example.com/feed')), false);
    assert.equal(isPublicFeedUrl(new URL('ftp://example.com/feed')), false);
    assert.equal(isPublicFeedUrl('https://example.com'), false);
  });
});

describe('looksLikeFeedXml', () => {
  test('recognizes RSS, Atom and RDF roots after a prolog', () => {
    assert.equal(looksLikeFeedXml(RSS), true);
    assert.equal(looksLikeFeedXml(String.fromCharCode(0xfeff) + '<?xml version="1.0"?>\n<!-- c --><?xml-stylesheet href="x"?>\n<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), true);
    assert.equal(looksLikeFeedXml('<rdf:RDF xmlns:rdf="x"></rdf:RDF>'), true);
  });

  test('refuses HTML, JSON and other XML documents', () => {
    assert.equal(looksLikeFeedXml('<!DOCTYPE html><html><body>hi</body></html>'), false);
    assert.equal(looksLikeFeedXml('{"items":[]}'), false);
    assert.equal(looksLikeFeedXml('<?xml version="1.0"?><svg></svg>'), false);
    assert.equal(looksLikeFeedXml('<rssfeed></rssfeed>'), false);
    assert.equal(looksLikeFeedXml(undefined), false);
  });
});

describe('rss-proxy custom mode', () => {
  test('without custom=1 an unlisted host is still refused', async () => {
    const calls = spyFetch(() => new Response(RSS));
    const response = await handler(makeRequest('https://my-reactor-blog.example.net/feed', { custom: false }));
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
  });

  test('relays a feed from an unlisted public host as inert text', async () => {
    const calls = spyFetch(() => new Response(RSS, { headers: { 'Content-Type': 'application/rss+xml' } }));
    const response = await handler(makeRequest('https://my-reactor-blog.example.net/feed'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await response.text(), RSS);
    assert.deepEqual(calls, ['https://my-reactor-blog.example.net/feed']);
  });

  test('refuses private and literal targets before fetching', async () => {
    const calls = spyFetch(() => new Response(RSS));
    for (const url of ['http://localhost/feed', 'http://10.0.0.1/rss', 'http://169.254.169.254/latest', 'https://intranet.corp/feed', 'https://example.net:8080/feed']) {
      const response = await handler(makeRequest(url));
      assert.equal(response.status, 403, url);
    }
    assert.equal(calls.length, 0);
  });

  test('refuses a body that is not a feed', async () => {
    spyFetch(() => new Response('<!doctype html><html><body>login</body></html>', { headers: { 'Content-Type': 'text/html' } }));
    const response = await handler(makeRequest('https://my-reactor-blog.example.net/'));
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'Not an RSS or Atom feed');
  });

  test('follows a redirect to another public host but not to a private one', async () => {
    spyFetch((url) => url.startsWith('https://old.example.net')
      ? new Response(null, { status: 301, headers: { Location: 'https://new.example.org/feed.xml' } })
      : new Response(RSS));
    const ok = await handler(makeRequest('https://old.example.net/feed'));
    assert.equal(ok.status, 200);

    spyFetch(() => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/admin' } }));
    const blocked = await handler(makeRequest('https://old.example.net/feed'));
    assert.equal(blocked.status, 403);
  });

  test('never falls back to the allowlist-only relay', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    const calls = spyFetch(() => { throw new TypeError('fetch failed'); });
    const response = await handler(makeRequest('https://my-reactor-blog.example.net/feed'));
    assert.equal(response.status, 502);
    assert.ok(calls.every((url) => !url.includes('relay.example.com')), calls.join(', '));
  });
});
