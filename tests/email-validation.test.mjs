import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock fetch globally for MX record checks so tests don't hit real DNS
const originalFetch = globalThis.fetch;

function mockFetch(mxResponse) {
  globalThis.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('cloudflare-dns.com')) {
      return { ok: true, json: async () => mxResponse };
    }
    return originalFetch(url);
  };
}

// Import after fetch is available (module is Edge-compatible, no node: imports)
const { validateEmail } = await import('../server/_shared/email-validation.ts');

describe('validateEmail', () => {
  beforeEach(() => {
    // Default: pretend every domain has MX records
    mockFetch({ Answer: [{ type: 15, data: '10 mx.example.com.' }] });
  });

  it('accepts a valid gmail address', async () => {
    const result = await validateEmail('user@gmail.com');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('accepts addresses with unusual but valid TLDs', async () => {
    const result = await validateEmail('user@company.photography');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('rejects disposable domain (guerrillamail)', async () => {
    const result = await validateEmail('test@guerrillamail.com');
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('Disposable'));
  });

  it('rejects disposable domain (yopmail)', async () => {
    const result = await validateEmail('test@yopmail.com');
    assert.strictEqual(result.valid, false);
  });

  it('rejects disposable domain (passmail.net)', async () => {
    const result = await validateEmail('worldmonitor.foo@passmail.net');
    assert.strictEqual(result.valid, false);
  });

  it('rejects offensive local part containing slur', async () => {
    const result = await validateEmail('ihateniggers@gmail.com');
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'Email address not accepted');
  });

  it('rejects offensive compound word in local part', async () => {
    const result = await validateEmail('fuckfaggot@example.com');
    assert.strictEqual(result.valid, false);
  });

  it('rejects offensive domain', async () => {
    const result = await validateEmail('user@nigger.edu');
    assert.strictEqual(result.valid, false);
  });

  it('rejects typo TLD .con', async () => {
    const result = await validateEmail('user@gmail.con');
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('typo'));
  });

  it('rejects typo TLD .coma', async () => {
    const result = await validateEmail('user@gmail.coma');
    assert.strictEqual(result.valid, false);
  });

  it('rejects typo TLD .comhade', async () => {
    const result = await validateEmail('alishakertube55.net@gmail.comhade');
    assert.strictEqual(result.valid, false);
  });

  it('rejects domain with no MX records', async () => {
    mockFetch({ Status: 0 }); // no Answer array
    const result = await validateEmail('user@nonexistent-domain-xyz.com');
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes('does not accept mail'));
  });

  it('fails open when DNS lookup errors', async () => {
    globalThis.fetch = async () => { throw new Error('network error'); };
    const result = await validateEmail('user@flaky-dns.com');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('fails open when DNS returns non-OK status', async () => {
    globalThis.fetch = async () => ({ ok: false });
    const result = await validateEmail('user@whatever.com');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('rejects email with no @ sign', async () => {
    const result = await validateEmail('invalidemail');
    assert.strictEqual(result.valid, false);
  });

  it('rejects email with nothing before @', async () => {
    const result = await validateEmail('@gmail.com');
    assert.strictEqual(result.valid, false);
  });

  it('is case-insensitive for disposable domains', async () => {
    const result = await validateEmail('test@GUERRILLAMAIL.COM');
    assert.strictEqual(result.valid, false);
  });

  it('allows duck.com (privacy relay, not disposable)', async () => {
    const result = await validateEmail('user@duck.com');
    assert.deepStrictEqual(result, { valid: true });
  });

  it('allows simplelogin.com (privacy relay, not disposable)', async () => {
    const result = await validateEmail('alias@simplelogin.com');
    assert.deepStrictEqual(result, { valid: true });
  });
});
