import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserApiKeyUnavailableError } from '../server/_shared/user-api-key';
import { EmbedKeyUnavailableError } from '../server/_shared/embed-key';
import { evaluateEmbedEntitlement, type EmbedEntitlementDeps } from '../server/_shared/embed-entitlement';

const __dirname = dirname(fileURLToPath(import.meta.url));

function deps(overrides: Partial<EmbedEntitlementDeps> = {}): EmbedEntitlementDeps {
  return {
    getValidEnterpriseKeys: () => [],
    timingSafeIncludes: async () => false,
    validateUserApiKey: async () => null,
    validateEmbedKey: async () => null,
    getEntitlements: async () => null,
    getAccountPlan: async () => 'free',
    isEntitlementBackendConfigured: () => true,
    ...overrides,
  };
}

describe('embed entitlement', () => {
  it('allows the public map without a key', async () => {
    const result = await evaluateEmbedEntitlement(null, null, deps());
    assert.equal(result.status, 200);
    assert.equal(result.body.allowed, true);
    assert.equal(result.body.panel, 'map');
    assert.equal(result.body.public, true);
  });

  it('rejects unknown panels', async () => {
    const result = await evaluateEmbedEntitlement('intel', 'wm_0123456789abcdef0123456789abcdef01234567', deps());
    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'unknown_panel');
  });

  // ---- wme_ embed keys on the two paid panels -----------------------------

  const EMBED_KEY = `wme_${'a1b2c3d4e5'.repeat(4)}`;
  const paidEntitlement = (overrides: Record<string, unknown> = {}) => ({
    planKey: 'pro_monthly',
    features: { tier: 1, apiAccess: false, embedAccess: true, apiRateLimit: 0, maxDashboards: 1, prioritySupport: false, exportFormats: [] },
    validUntil: Date.now() + 86_400_000,
    ...overrides,
  });

  it('leaves the deprecation marker off a wme_ answer', async () => {
    const result = await evaluateEmbedEntitlement('fear-greed', EMBED_KEY, deps({
      validateEmbedKey: async () => ({ userId: 'user_embed' }),
      getEntitlements: async () => paidEntitlement(),
    }));
    assert.equal(result.body.deprecatedCredential, undefined);
  });

  it('keeps the free map tier keyless even when a wme_ key is presented', async () => {
    let embedValidatorCalls = 0;
    const result = await evaluateEmbedEntitlement('map', EMBED_KEY, deps({
      validateEmbedKey: async () => { embedValidatorCalls += 1; return null; },
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.public, true);
    assert.equal(embedValidatorCalls, 0, 'the free tier answers before any credential lookup');
  });

  it('strips cookies and ignores viewer bearers in the entitlement edge handler', () => {
    const source = readFileSync(resolve(__dirname, '../api/embed/entitlement.ts'), 'utf-8');
    assert.match(source, /headers\.delete\('cookie'\)/);
    assert.match(source, /checkEndpointRateLimit/);
    // Keyed to the embedding account's key header; resolution is covered in
    // embed-session.test.mts ("credential header resolution").
    assert.match(source, /embedCredentialFromHeaders\(stripped\.headers\)/);
    assert.match(source, /isEntitlementBackendConfigured/);
    assert.equal(source.includes('validateBearerToken'), false);
    assert.equal(source.includes('getCookie'), false);
  });
});
